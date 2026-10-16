-- 0010: 직접 만든 방은 지우지 않는 한 사라지지 않아요
-- Supabase SQL Editor에서 새 쿼리를 열고 이 파일 내용을 붙여넣은 뒤 Run 하면 돼요.
--
--  직접 방 (자동 방 규칙은 그대로예요)
--  · 확정: 패스한 사람을 빼고, 초대받은 사람이 모두 참석하면 확정 (나 포함 2명 이상)
--  · 응답 마감이 지나도 사라지지 않아요. 그때 참석한 사람이 2명 이상이면 그 사람들끼리 확정돼요
--    (마감 뒤에도 답 안 한 사람은 나중에 참석할 수 있어요)
--  · 확정 후 누가 빠지거나 그룹을 나가도 방은 그대로예요
--  · 없애기: 확정 전에는 참석·초대받은 사람 누구나, 확정 후에는 만든 사람만
--    (만든 사람이 그룹을 나갔으면 참석자 누구나)

-- 응답 마감이 지난 방도 직접 방은 보여요
drop policy if exists rooms_read on public.rooms;
create policy rooms_read on public.rooms for select to authenticated
  using (
    public.is_room_invitee(id)
    and not (kind = 'auto' and status = 'open' and reply_deadline < now())
  );

-- 직접 방 확정 확인: 답 안 한 사람이 없고 참석 2명 이상
create or replace function public.manual_check_confirm(p_room uuid, p_deadline_passed boolean default false)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_joined int;
  v_waiting int;
begin
  select count(*) filter (where status = 'joined'), count(*) filter (where status = 'invited')
    into v_joined, v_waiting from room_members where room_id = p_room;
  if v_joined >= 2 and (v_waiting = 0 or p_deadline_passed) then
    update rooms set status = 'confirmed' where id = p_room and status = 'open';
    return found;
  end if;
  return false;
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

  select threshold into v_threshold from groups where id = r.group_id;

  -- 확정된 모임에서 빠지기
  if r.status = 'confirmed' and v_old = 'joined' and p_status <> 'joined' then
    update room_members set status = 'passed', updated_at = now()
      where room_id = p_room and member_id = v_me;
    select count(*) into v_joined from room_members where room_id = p_room and status = 'joined';
    if r.kind = 'auto' then
      perform forget_paint(v_me, r.day, r.slot);
      if v_joined < v_threshold then
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

create or replace function public.delete_room(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r rooms;
  v_me uuid;
begin
  select * into r from rooms where id = p_room;
  select rm.member_id into v_me from room_members rm join members m on m.id = rm.member_id
    where rm.room_id = p_room and m.user_id = auth.uid() and rm.status <> 'passed';
  if r.id is null or v_me is null then raise exception 'not allowed'; end if;
  if r.status = 'confirmed' and (r.kind = 'auto' or (r.created_by is not null and r.created_by <> v_me)) then
    raise exception 'leave instead';
  end if;
  if r.kind = 'auto' then perform forget_paint(v_me, r.day, r.slot); end if;
  perform delete_room_internal(p_room);
end $$;

-- 멤버가 나가거나 내보내질 때: 직접 방은 남겨요
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
        if v_joined < (select threshold from groups where id = r.group_id) then
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

-- 정리: 자동 방만 마감 뒤 사라지고, 직접 방은 마감 때 참석자끼리 확정
create or replace function public.cleanup_rooms()
returns void language plpgsql security definer set search_path = public as $$
declare x record;
begin
  insert into dismissed_slots (group_id, day, slot, dismissed_at)
    select group_id, day, slot, now() from rooms
    where kind = 'auto' and status = 'open' and reply_deadline < now()
    on conflict (group_id, day, slot) do update set dismissed_at = now();
  delete from rooms where kind = 'auto' and status = 'open' and reply_deadline < now();

  for x in select id from rooms where kind = 'manual' and status = 'open' and reply_deadline < now() loop
    perform manual_check_confirm(x.id, true);
  end loop;

  delete from dismissed_slots where day < seoul_today();
  delete from availability where day < seoul_today() - 1;
  perform recheck_all_rooms();
end $$;

revoke execute on function public.manual_check_confirm(uuid, boolean), public.remove_member_internal(uuid), public.cleanup_rooms()
  from public, anon, authenticated;
