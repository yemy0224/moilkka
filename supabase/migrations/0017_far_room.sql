-- 0017: (0015 포함) 이미 있는 자동 방은 모임 날까지 칠한 사람을 초대하고,
--       같은 날 같은 끼니에 직접 만든 방이 있으면 자동 방을 따로 만들지 않아요
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

    insert into rooms (group_id, kind, day, slot, reply_deadline)
      values (p_group, 'auto', p_day, v_slot,
        least(now() + interval '3 days', ((p_day - 5)::timestamp + interval '21 hours') at time zone 'Asia/Seoul'))
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

revoke execute on function public.check_auto_room(uuid, date, text) from public, anon, authenticated;
