-- 0005: 규칙 다듬기 (서로 부딪히는 부분 정리)
-- Supabase SQL Editor에서 새 쿼리를 열고 이 파일 내용을 붙여넣은 뒤 Run 하면 돼요.
--
--  1) 지운 시간대도 누가 "새로 칠하면" 다시 방이 생겨요
--     · 방을 지우거나(X) 확정 후 빠지거나 패스한 사람은 그 칸 칠이 자동으로 지워져요
--     · 남은 칠만으로는 다시 안 생기고, 누군가 새로 칠한 순간 다시 확인해요
--  2) 응답 마감이 지나 사라진 방이 1분 뒤 똑같이 다시 생기던 문제를 막아요
--     (위와 같은 방식: 새로 칠해야 다시 생겨요)
--  3) 마감 시간이 겹치지 않게
--     · 자동 방 응답 마감: 3일 뒤와 "모임 5일 전 밤 9시" 중 빠른 쪽
--     · 시간·식당 투표 마감: 모임 5일 전 → 3일 전 밤 9시
--       (응답이 끝난 뒤에도 투표할 시간이 최소 이틀 남아요. 동표면 하루 더 → 2일 전 밤 9시에 식당 확정)
--  4) 직접 방(번개) 응답 마감: 3일 뒤와 "모임 전날 밤 9시" 중 빠른 쪽,
--     그게 이미 지났거나 너무 촉박하면 모임 날 밤 12시까지

-- 언제 지워졌는지 기록
alter table public.dismissed_slots add column if not exists dismissed_at timestamptz not null default now();

-- 시간·식당 투표 마감: 모임 3일 전 밤 9시 (한국 시간)
create or replace function public.vote_deadline_of(p_day date) returns timestamptz
language sql stable as $$
  select ((p_day - 3)::timestamp + interval '21 hours') at time zone 'Asia/Seoul'
$$;

-- 내 칠 지우기 (패스·취소·X 할 때)
create or replace function public.forget_paint(p_member uuid, p_day date, p_slot text)
returns void language sql security definer set search_path = public as $$
  delete from availability where member_id = p_member and day = p_day and slot = p_slot
$$;

-- 자동 방 만들기
create or replace function public.check_auto_room(p_group uuid, p_day date, p_slot text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_today date := seoul_today();
  v_threshold int;
  v_count int;
  v_rid uuid;
  v_dismissed timestamptz;
begin
  if p_day < v_today + 8 or p_day > v_today + 14 then return; end if;

  select id into v_rid from rooms
    where group_id = p_group and day = p_day and slot = p_slot and kind = 'auto';

  if v_rid is null then
    -- 지워진 시간대: 그 뒤에 누가 새로 칠했을 때만 다시 확인
    select dismissed_at into v_dismissed from dismissed_slots
      where group_id = p_group and day = p_day and slot = p_slot;
    if v_dismissed is not null and not exists (
      select 1 from availability
      where group_id = p_group and day = p_day and slot = p_slot and created_at > v_dismissed
    ) then return; end if;

    select threshold into v_threshold from groups where id = p_group;
    select count(*) into v_count from availability
      where group_id = p_group and day = p_day and slot = p_slot;
    if v_count < v_threshold then return; end if;

    insert into rooms (group_id, kind, day, slot, reply_deadline)
      values (p_group, 'auto', p_day, p_slot,
        least(now() + interval '3 days', ((p_day - 5)::timestamp + interval '21 hours') at time zone 'Asia/Seoul'))
      on conflict do nothing
      returning id into v_rid;
    if v_rid is null then return; end if;
    delete from dismissed_slots where group_id = p_group and day = p_day and slot = p_slot;
  end if;

  -- 그 시간대를 칠한 사람은 모두 초대 (나중에 칠한 사람도)
  insert into room_members (room_id, member_id)
    select v_rid, a.member_id from availability a
    where a.group_id = p_group and a.day = p_day and a.slot = p_slot
    on conflict do nothing;
end $$;

-- 방 없애기: 시간대 기록 (다시 칠하기 전엔 안 생겨요)
create or replace function public.delete_room_internal(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r rooms;
begin
  select * into r from rooms where id = p_room;
  if r.id is null then return; end if;
  if r.kind = 'auto' then
    insert into dismissed_slots (group_id, day, slot, dismissed_at) values (r.group_id, r.day, r.slot, now())
      on conflict (group_id, day, slot) do update set dismissed_at = now();
  end if;
  delete from rooms where id = p_room;
end $$;

create or replace function public.respond_room(p_room uuid, p_status text)
returns text language plpgsql security definer set search_path = public as $$
declare
  r rooms;
  v_me uuid;
  v_old text;
  v_threshold int;
  v_joined int;
  v_total int;
begin
  if p_status not in ('joined', 'passed', 'invited') then raise exception 'bad status'; end if;
  select * into r from rooms where id = p_room for update;
  if r.id is null then raise exception 'room not found'; end if;

  select rm.member_id, rm.status into v_me, v_old
    from room_members rm join members m on m.id = rm.member_id
    where rm.room_id = p_room and m.user_id = auth.uid();
  if v_me is null then raise exception 'not invited'; end if;

  -- 확정된 모임에서 빠지면 방이 없어져요 (내 칠도 지워요)
  if r.status = 'confirmed' and v_old = 'joined' and p_status <> 'joined' then
    if r.kind = 'auto' then perform forget_paint(v_me, r.day, r.slot); end if;
    perform delete_room_internal(p_room);
    return 'deleted';
  end if;

  if r.status = 'open' and r.reply_deadline < now() then raise exception 'room expired'; end if;

  update room_members set status = p_status, updated_at = now()
    where room_id = p_room and member_id = v_me;

  -- 패스하면 그 칸 칠도 지워요 (다른 친구 캘린더 숫자가 정확해지게)
  if p_status = 'passed' and r.kind = 'auto' then perform forget_paint(v_me, r.day, r.slot); end if;

  if r.status = 'open' then
    select count(*) filter (where status = 'joined'), count(*)
      into v_joined, v_total from room_members where room_id = p_room;
    if r.kind = 'auto' then
      select threshold into v_threshold from groups where id = r.group_id;
      if v_joined >= v_threshold then
        update rooms set status = 'confirmed' where id = p_room;
        return 'confirmed';
      end if;
    elsif v_joined = v_total then
      update rooms set status = 'confirmed' where id = p_room;
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
  if r.kind = 'auto' then perform forget_paint(v_me, r.day, r.slot); end if;
  perform delete_room_internal(p_room);
end $$;

-- 직접 방(번개 포함)
create or replace function public.create_manual_room(
  p_group uuid, p_title text, p_day date, p_slot text, p_time text, p_invitees uuid[]
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me uuid;
  v_rid uuid;
  v_deadline timestamptz;
begin
  select id into v_me from members where group_id = p_group and user_id = auth.uid();
  if v_me is null then raise exception 'not a member'; end if;
  if p_slot not in ('L', 'D') then raise exception 'bad slot'; end if;
  if coalesce(array_length(p_invitees, 1), 0) = 0 then raise exception 'pick friends'; end if;
  if p_day < seoul_today() then raise exception 'past date'; end if;
  if exists (
    select 1 from unnest(p_invitees) i
    where not exists (select 1 from members m where m.id = i and m.group_id = p_group)
  ) then raise exception 'unknown friend'; end if;

  v_deadline := manual_deadline_of(p_day);

  insert into rooms (group_id, kind, title, day, slot, time_label, reply_deadline, created_by)
    values (p_group, 'manual', nullif(trim(p_title), ''), p_day, p_slot, p_time, v_deadline, v_me)
    returning id into v_rid;
  insert into room_members (room_id, member_id, status) values (v_rid, v_me, 'joined');
  insert into room_members (room_id, member_id)
    select v_rid, i from unnest(p_invitees) i where i <> v_me
    on conflict do nothing;
  return v_rid;
end $$;

-- 직접 방 응답 마감: 3일 뒤와 모임 전날 밤 9시 중 빠른 쪽, 촉박하면 모임 날 밤 12시
create or replace function public.manual_deadline_of(p_day date) returns timestamptz
language plpgsql stable as $$
declare v timestamptz;
begin
  v := least(now() + interval '3 days', ((p_day - 1)::timestamp + interval '21 hours') at time zone 'Asia/Seoul');
  if v < now() + interval '3 hours' then
    v := ((p_day + 1)::timestamp at time zone 'Asia/Seoul');
  end if;
  return v;
end $$;

-- 정리: 마감이 지나 사라지는 자동 방도 시간대를 기록 (1분 뒤 똑같이 다시 생기지 않게)
create or replace function public.cleanup_rooms()
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into dismissed_slots (group_id, day, slot, dismissed_at)
    select group_id, day, slot, now() from rooms
    where kind = 'auto' and status = 'open' and reply_deadline < now()
    on conflict (group_id, day, slot) do update set dismissed_at = now();
  delete from rooms where status = 'open' and reply_deadline < now();
  delete from dismissed_slots where day < seoul_today();
  delete from availability where day < seoul_today() - 1;
  perform recheck_all_rooms();
end $$;

-- 지금 열려 있는 자동 방의 응답 마감도 새 규칙에 맞게 (늦춰지진 않고 당겨지기만 해요)
update public.rooms
  set reply_deadline = least(reply_deadline, ((day - 5)::timestamp + interval '21 hours') at time zone 'Asia/Seoul')
  where kind = 'auto' and status = 'open';

revoke execute on function public.forget_paint(uuid, date, text), public.manual_deadline_of(date),
  public.check_auto_room(uuid, date, text), public.delete_room_internal(uuid), public.cleanup_rooms()
  from public, anon, authenticated;
grant execute on function public.manual_deadline_of(date) to authenticated;
