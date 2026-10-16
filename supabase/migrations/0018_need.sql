-- 0018: 기준 인원 정책 정리
--  1) 확정된 모임은 2명 미만이 될 때만 사라져요 (기준 인원을 올려도 이미 잡힌 약속은 그대로)
--  2) 자동 방은 생길 때의 기준 인원을 방에 저장해요 (기준 인원을 바꾸면 새 방부터 적용)

alter table public.rooms add column if not exists need int;
update public.rooms r set need = g.threshold
  from public.groups g
  where g.id = r.group_id and r.kind = 'auto' and r.need is null;

create or replace function public.check_auto_room(p_group uuid, p_day date, p_slot text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_today date := seoul_today();
  v_threshold int;
  v_l int;
  v_d int;
  v_slot text;
  r rooms;
  v_dismissed timestamptz;
begin
  if p_day < v_today then return; end if;
  select threshold into v_threshold from groups where id = p_group;
  select count(*) filter (where slot = 'L'), count(*) filter (where slot = 'D') into v_l, v_d
    from availability where group_id = p_group and day = p_day;

  select * into r from rooms where group_id = p_group and day = p_day and kind = 'auto';

  -- 새 방은 8~14일 뒤에만 생겨요. 이미 있는 방은 날짜와 상관없이 칠한 사람을 초대해요
  if r.id is null and (p_day < v_today + 8 or p_day > v_today + 14) then return; end if;

  if r.id is null then
    -- 없어진 시간대: 그 뒤에 그날 누가 새로 칠했을 때만 다시 확인
    select max(dismissed_at) into v_dismissed from dismissed_slots where group_id = p_group and day = p_day;
    if v_dismissed is not null and not exists (
      select 1 from availability where group_id = p_group and day = p_day and created_at > v_dismissed
    ) then return; end if;

    -- 같은 날 같은 끼니에 직접 만든 방이 있으면 그 끼니는 자동 방을 안 만들어요 (중복 방지)
    if exists (select 1 from rooms where group_id = p_group and day = p_day and kind = 'manual' and slot = 'L') then v_l := 0; end if;
    if exists (select 1 from rooms where group_id = p_group and day = p_day and kind = 'manual' and slot = 'D') then v_d := 0; end if;
    v_slot := case when v_l >= v_threshold and v_d >= v_threshold then 'B'
                   when v_l >= v_threshold then 'L'
                   when v_d >= v_threshold then 'D' end;
    if v_slot is null then return; end if;

    insert into rooms (group_id, kind, day, slot, reply_deadline, need)
      values (p_group, 'auto', p_day, v_slot,
        least(now() + interval '3 days', ((p_day - 5)::timestamp + interval '21 hours') at time zone 'Asia/Seoul'), v_threshold)
      on conflict do nothing
      returning * into r;
    if r.id is null then return; end if;
    delete from dismissed_slots where group_id = p_group and day = p_day;
  elsif r.slot <> 'B' and not r.finalized and p_day >= v_today + 8
        and not exists (select 1 from rooms where group_id = p_group and day = p_day and kind = 'manual' and slot <> r.slot)
        and ((r.slot = 'L' and v_d >= v_threshold) or (r.slot = 'D' and v_l >= v_threshold)) then
    -- 다른 끼니도 N명이 됐고 시간이 아직 안 정해졌으면 넓혀요
    update rooms set slot = 'B' where id = r.id returning * into r;
  end if;

  -- 그 방의 끼니를 칠한 사람은 모두 초대 (나중에 칠한 사람도)
  insert into room_members (room_id, member_id)
    select r.id, a.member_id from availability a
    where a.group_id = p_group and a.day = p_day and (a.slot = r.slot or r.slot = 'B')
    on conflict do nothing;
end $$;

create or replace function public.respond_room(p_room uuid, p_status text)
returns text language plpgsql security definer set search_path = public as $$
declare
  r rooms;
  v_me uuid;
  v_old text;
  v_threshold int;
  v_joined int;
begin
  if p_status not in ('joined', 'passed', 'invited') then raise exception 'bad status'; end if;
  select * into r from rooms where id = p_room for update;
  if r.id is null then raise exception 'room not found'; end if;

  select rm.member_id, rm.status into v_me, v_old
    from room_members rm join members m on m.id = rm.member_id
    where rm.room_id = p_room and m.user_id = auth.uid();
  if v_me is null then raise exception 'not invited'; end if;

  v_threshold := coalesce(r.need, (select threshold from groups where id = r.group_id));

  -- 확정된 모임에서 빠지기
  if r.status = 'confirmed' and v_old = 'joined' and p_status <> 'joined' then
    update room_members set status = 'passed', updated_at = now()
      where room_id = p_room and member_id = v_me;
    select count(*) into v_joined from room_members where room_id = p_room and status = 'joined';
    if r.kind = 'auto' then
      perform forget_paint(v_me, r.day, r.slot);
      if v_joined < 2 then
        perform delete_room_internal(p_room);
        return 'deleted';
      end if;
    end if;
    perform enqueue_joined(p_room, 'invite', '한 명이 빠졌어요',
      coalesce(r.title || ' · ', '') || kdate(r.day) || ' ' || kslot(r.slot) || ' · 지금 ' || v_joined || '명, 모임은 그대로예요');
    return 'left';
  end if;

  if r.kind = 'auto' and r.status = 'open' and r.reply_deadline < now() then raise exception 'room expired'; end if;

  update room_members set status = p_status, updated_at = now()
    where room_id = p_room and member_id = v_me;

  if p_status = 'passed' and r.kind = 'auto' then perform forget_paint(v_me, r.day, r.slot); end if;

  if r.status = 'open' then
    if r.kind = 'auto' then
      select count(*) into v_joined from room_members where room_id = p_room and status = 'joined';
      if v_joined >= v_threshold then
        update rooms set status = 'confirmed' where id = p_room;
        return 'confirmed';
      end if;
    elsif manual_check_confirm(p_room, r.reply_deadline < now()) then
      return 'confirmed';
    end if;
  end if;
  return r.status;
end $$;

create or replace function public.remove_member_internal(p_member uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m members;
  r record;
  v_joined int;
begin
  select * into m from members where id = p_member;
  if m.id is null then return; end if;

  for r in
    select ro.*, rm.status as my_status from rooms ro join room_members rm on rm.room_id = ro.id
    where rm.member_id = p_member
  loop
    delete from room_members where room_id = r.id and member_id = p_member;
    select count(*) into v_joined from room_members where room_id = r.id and status = 'joined';

    if r.kind = 'auto' then
      if r.status = 'confirmed' and r.my_status = 'joined' then
        if v_joined < 2 then
          perform delete_room_internal(r.id);
        else
          perform enqueue_joined(r.id, 'invite', '한 명이 빠졌어요',
            kdate(r.day) || ' ' || kslot(r.slot) || ' · 지금 ' || v_joined || '명, 모임은 그대로예요');
        end if;
      end if;
    else
      if not exists (select 1 from room_members where room_id = r.id) then
        delete from rooms where id = r.id;          -- 아무도 안 남은 방만 정리
      elsif r.status = 'open' then
        perform manual_check_confirm(r.id, r.reply_deadline < now());
      elsif r.my_status = 'joined' then
        perform enqueue_joined(r.id, 'invite', '한 명이 빠졌어요',
          coalesce(r.title || ' · ', '') || kdate(r.day) || ' ' || kslot(r.slot) || ' · 지금 ' || v_joined || '명, 모임은 그대로예요');
      end if;
    end if;
  end loop;

  delete from members where id = p_member;

  if exists (select 1 from groups where id = m.group_id and owner_id = m.user_id) then
    update groups set owner_id = (
      select user_id from members where group_id = m.group_id order by created_at limit 1
    ) where id = m.group_id and exists (select 1 from members where group_id = m.group_id);
  end if;
end $$;

revoke execute on function public.check_auto_room(uuid, date, text), public.remove_member_internal(uuid) from public, anon, authenticated;
