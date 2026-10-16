-- 0012: 자동 방은 하루에 하나
-- Supabase SQL Editor에서 새 쿼리를 열고 이 파일 내용을 붙여넣은 뒤 Run 하면 돼요.
--
--  · 점심만 N명 겹치면 점심 방, 저녁만이면 저녁 방, 둘 다면 "점심 또는 저녁" 방(slot = 'B') 하나
--  · 이미 점심(또는 저녁) 방이 있는데 다른 끼니도 N명이 되면, 시간이 아직 안 정해졌을 때만 "점심 또는 저녁"으로 넓혀요
--    (새로 그 끼니를 칠한 사람에게도 초대장이 가요)
--  · "점심 또는 저녁" 방의 시간 후보는 6개. 마감 때 1위로 정하고, 정해지면 방도 점심/저녁 방이 돼요
--    아무도 안 고르면 칠한 사람이 더 많은 끼니의 가운데 시간
--  · 패스·빠지기·X: 그 방의 끼니 칠을 지워요 ("점심 또는 저녁" 방이면 그날 둘 다)
--  · 이미 같은 날 두 개가 생긴 방은 하나로 합쳐요 (알림 없이)

-- 'B' = 점심 또는 저녁
alter table public.rooms drop constraint if exists rooms_slot_check;
alter table public.rooms add constraint rooms_slot_check check (slot in ('L', 'D', 'B'));

create or replace function public.kslot(p_slot text) returns text
language sql immutable as $$ select case p_slot when 'L' then '점심' when 'D' then '저녁' else '점심 또는 저녁' end $$;

create or replace function public.time_options(p_slot text) returns text[]
language sql immutable as $$
  select case p_slot
    when 'L' then array['오전 11시', '오후 12시', '오후 1시']
    when 'D' then array['오후 5시', '오후 5시 반', '오후 6시']
    else array['오전 11시', '오후 12시', '오후 1시', '오후 5시', '오후 5시 반', '오후 6시'] end
$$;

-- 패스·빠지기 때 지우는 칠: 'B'면 그날 점심·저녁 둘 다
create or replace function public.forget_paint(p_member uuid, p_day date, p_slot text)
returns void language sql security definer set search_path = public as $$
  delete from availability where member_id = p_member and day = p_day and (slot = p_slot or p_slot = 'B')
$$;

-- 없어진 방: 'B'면 두 끼니 모두 기록
create or replace function public.delete_room_internal(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r rooms;
begin
  select * into r from rooms where id = p_room;
  if r.id is null then return; end if;
  if r.kind = 'auto' then
    insert into dismissed_slots (group_id, day, slot, dismissed_at)
      select r.group_id, r.day, s, now() from unnest(case when r.slot = 'B' then array['L', 'D'] else array[r.slot] end) s
      on conflict (group_id, day, slot) do update set dismissed_at = now();
  end if;
  delete from rooms where id = p_room;
end $$;

-- ─────────────────────────────────────────────
-- 이미 같은 날 두 개 생긴 자동 방 합치기 (알림 없이)
-- ─────────────────────────────────────────────
alter table public.rooms disable trigger user;
alter table public.room_members disable trigger user;

do $$
declare
  d record;
  keep rooms;
  other rooms;
begin
  for d in
    select group_id, day from rooms where kind = 'auto' group by group_id, day having count(*) > 1
  loop
    -- 확정된 방(없으면 먼저 생긴 방)을 남겨요
    select * into keep from rooms where kind = 'auto' and group_id = d.group_id and day = d.day
      order by (status = 'confirmed') desc, finalized desc, created_at limit 1;
    for other in
      select * from rooms where kind = 'auto' and group_id = d.group_id and day = d.day and id <> keep.id
    loop
      -- 참석 > 초대 > 패스 순으로 합쳐요
      insert into room_members (room_id, member_id, status, updated_at)
        select keep.id, rm.member_id, rm.status, rm.updated_at from room_members rm where rm.room_id = other.id
        on conflict (room_id, member_id) do update set status = case
          when room_members.status = 'joined' or excluded.status = 'joined' then 'joined'
          when room_members.status = 'invited' or excluded.status = 'invited' then 'invited'
          else 'passed' end;
      if not keep.finalized then
        insert into time_votes (room_id, member_id, label)
          select keep.id, v.member_id, v.label from time_votes v where v.room_id = other.id
          on conflict (room_id, member_id) do nothing;
      end if;
      if keep.status = 'open' and other.status = 'confirmed' then
        update rooms set status = 'confirmed' where id = keep.id;
      end if;
      delete from rooms where id = other.id;
    end loop;
    if not keep.finalized then
      update rooms set slot = 'B' where id = keep.id;
    end if;
  end loop;
end $$;

alter table public.rooms enable trigger user;
alter table public.room_members enable trigger user;

drop index if exists public.rooms_auto_unique;
create unique index rooms_auto_unique on public.rooms (group_id, day) where kind = 'auto';

-- ─────────────────────────────────────────────
-- 자동 방 만들기·넓히기 (하루 단위)
-- ─────────────────────────────────────────────
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
  if p_day < v_today + 8 or p_day > v_today + 14 then return; end if;
  select threshold into v_threshold from groups where id = p_group;
  select count(*) filter (where slot = 'L'), count(*) filter (where slot = 'D') into v_l, v_d
    from availability where group_id = p_group and day = p_day;

  select * into r from rooms where group_id = p_group and day = p_day and kind = 'auto';

  if r.id is null then
    -- 없어진 시간대: 그 뒤에 그날 누가 새로 칠했을 때만 다시 확인
    select max(dismissed_at) into v_dismissed from dismissed_slots where group_id = p_group and day = p_day;
    if v_dismissed is not null and not exists (
      select 1 from availability where group_id = p_group and day = p_day and created_at > v_dismissed
    ) then return; end if;

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
  elsif r.slot <> 'B' and not r.finalized
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

-- ─────────────────────────────────────────────
-- 마감: 시간·식당 확정 ("점심 또는 저녁"이면 끼니도 정해요)
-- ─────────────────────────────────────────────
create or replace function public.finalize_room(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r rooms;
  v_time text;
  v_n int;
  v_default text;
  v_top int;
  v_ids uuid[];
  v_pick uuid;
  v_slot text;
begin
  select * into r from rooms where id = p_room for update;
  if r.id is null or r.status <> 'confirmed' then return; end if;

  -- 동표 최종 하트 마감
  if r.tie_place_ids is not null and r.tie_deadline < now() then
    select t.pid into v_pick from (
      select p.pid, (select count(*) from tie_votes v where v.room_id = r.id and v.place_id = p.pid) as votes, p.n
      from unnest(r.tie_place_ids) with ordinality as p(pid, n)
    ) t order by t.votes desc, t.n limit 1;
    update rooms set place_id = v_pick, tie_place_ids = null, tie_deadline = null where id = r.id;
    return;
  end if;

  if r.kind <> 'auto' or r.finalized or vote_deadline_of(r.day) > now() then return; end if;

  -- 아무도 안 고르면: 점심/저녁 방은 가운데, "점심 또는 저녁"이면 칠한 사람이 더 많은 끼니의 가운데
  v_default := case r.slot
    when 'L' then '오후 12시'
    when 'D' then '오후 5시 반'
    else case when (select count(*) filter (where slot = 'L') >= count(*) filter (where slot = 'D')
                    from availability where group_id = r.group_id and day = r.day)
              then '오후 12시' else '오후 5시 반' end end;

  select o.label, o.n into v_time, v_n
  from unnest(time_options(r.slot)) with ordinality as o(label, n)
  left join (
    select v.label, count(*) as c from time_votes v
    join room_members rm on rm.room_id = v.room_id and rm.member_id = v.member_id and rm.status = 'joined'
    where v.room_id = r.id group by v.label
  ) c on c.label = o.label
  order by coalesce(c.c, 0) desc, (o.label = v_default) desc, o.n
  limit 1;

  v_slot := case when r.slot <> 'B' then r.slot when v_time = any (time_options('L')) then 'L' else 'D' end;

  if r.place_id is null then
    select max(x.hearts) into v_top from room_place_ranking_internal(r.id) x;
    if coalesce(v_top, 0) > 0 then
      select array_agg(x.id order by x.created_at) into v_ids
        from room_place_ranking_internal(r.id) x where x.hearts = v_top;
    end if;
  end if;

  update rooms set
    time_label = v_time,
    slot = v_slot,
    finalized = true,
    place_id = case when r.place_id is null and array_length(v_ids, 1) = 1 then v_ids[1] else place_id end,
    tie_place_ids = case when r.place_id is null and array_length(v_ids, 1) > 1 then v_ids else tie_place_ids end,
    tie_deadline = case when r.place_id is null and array_length(v_ids, 1) > 1 then now() + interval '1 day' else tie_deadline end
  where id = r.id;
end $$;

-- ─────────────────────────────────────────────
-- 빠르게 칠하기: "점심 또는 저녁" 방도 내 방으로 보고 건너뛰기
-- ─────────────────────────────────────────────
create or replace function public.bulk_paint(p_group uuid, p_kind text)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_me uuid;
  v_slot text;
  v_dows int[];
  v_n int;
begin
  select id into v_me from members where group_id = p_group and user_id = auth.uid();
  if v_me is null then raise exception 'not a member'; end if;
  case p_kind
    when 'weekend_dinner' then v_slot := 'D'; v_dows := array[0, 6];
    when 'weekend_lunch'  then v_slot := 'L'; v_dows := array[0, 6];
    when 'weekday_dinner' then v_slot := 'D'; v_dows := array[1, 2, 3, 4, 5];
    else raise exception 'bad kind';
  end case;

  insert into availability (member_id, group_id, day, slot)
    select v_me, p_group, d::date, v_slot
    from generate_series(seoul_today() + 1, seoul_today() + 28, interval '1 day') d
    where extract(dow from d)::int = any (v_dows)
      and not exists (select 1 from availability a where a.member_id = v_me and a.day = d::date and a.slot = v_slot)
      and not exists (select 1 from dismissed_slots x where x.group_id = p_group and x.day = d::date and x.slot = v_slot)
      and not exists (
        select 1 from rooms r join room_members rm on rm.room_id = r.id
        where r.group_id = p_group and r.day = d::date and r.slot in (v_slot, 'B') and r.kind = 'auto' and rm.member_id = v_me
      )
      and not exists (select 1 from my_busy(p_group) b where b.day = d::date and b.slot in (v_slot, 'B'))
    order by d;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke execute on function public.forget_paint(uuid, date, text), public.delete_room_internal(uuid),
  public.check_auto_room(uuid, date, text), public.finalize_room(uuid)
  from public, anon, authenticated;
