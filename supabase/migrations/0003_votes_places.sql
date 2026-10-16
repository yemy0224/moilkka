-- 0003: 시간 투표와 맛집 풀
-- Supabase SQL Editor에서 새 쿼리를 열고 이 파일 내용을 붙여넣은 뒤 Run 하면 돼요.
--
-- 규칙
--  · 시간: 확정된 자동 방에서 3개 중 하나. 모임 5일 전 밤 9시에 1위로 확정 (아무도 안 고르면 가운데 시간)
--  · 식당: 참석자 하트가 가장 많은 곳. 같은 시각에 동표면 동표인 곳만 놓고 하루 동안 최종 하트 하나씩
--  · 직접 만든 방은 시간이 이미 정해져 있어요. 식당은 참석자가 1순위를 보고 정해요
--  · 참석자는 언제든 식당을 바꿀 수 있어요

-- ─────────────────────────────────────────────
-- 테이블
-- ─────────────────────────────────────────────

alter table public.rooms add column if not exists place_id uuid;
alter table public.rooms add column if not exists finalized boolean not null default false;
alter table public.rooms add column if not exists tie_place_ids uuid[];
alter table public.rooms add column if not exists tie_deadline timestamptz;

create table public.places (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  category text check (category is null or char_length(category) <= 20),
  area text check (area is null or char_length(area) <= 20),
  url text check (url is null or (char_length(url) <= 300 and url ~* '^https://([a-z0-9-]+\.)*(naver\.me|naver\.com)/')),
  added_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index places_group_idx on public.places (group_id);

alter table public.rooms
  add constraint rooms_place_fk foreign key (place_id) references public.places(id) on delete set null;

-- 가고 싶다 하트 (누가 눌렀는지는 본인만)
create table public.place_hearts (
  place_id uuid not null references public.places(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (place_id, member_id)
);

-- 시간 투표 (한 사람 하나)
create table public.time_votes (
  room_id uuid not null references public.rooms(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  label text not null,
  primary key (room_id, member_id)
);

-- 식당 동표일 때 최종 하트 (한 사람 하나)
create table public.tie_votes (
  room_id uuid not null references public.rooms(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  primary key (room_id, member_id)
);

alter table public.places enable row level security;
alter table public.place_hearts enable row level security;
alter table public.time_votes enable row level security;
alter table public.tie_votes enable row level security;

create policy places_read on public.places for select to authenticated
  using (public.is_group_member(group_id));
create policy hearts_read_own on public.place_hearts for select to authenticated
  using (public.is_my_member(member_id));
create policy time_votes_read_own on public.time_votes for select to authenticated
  using (public.is_my_member(member_id));
create policy tie_votes_read_own on public.tie_votes for select to authenticated
  using (public.is_my_member(member_id));

revoke all on public.places, public.place_hearts, public.time_votes, public.tie_votes from anon;
revoke insert, update, delete on public.places, public.place_hearts, public.time_votes, public.tie_votes from authenticated;

-- ─────────────────────────────────────────────
-- 도우미
-- ─────────────────────────────────────────────

create or replace function public.time_options(p_slot text) returns text[]
language sql immutable as $$
  select case p_slot when 'L' then array['오전 11시', '오후 12시', '오후 1시']
                     else array['오후 5시', '오후 5시 반', '오후 6시'] end
$$;

-- 시간 투표 마감: 모임 5일 전 밤 9시 (한국 시간)
create or replace function public.vote_deadline_of(p_day date) returns timestamptz
language sql stable as $$
  select ((p_day - 5)::timestamp + interval '21 hours') at time zone 'Asia/Seoul'
$$;

create or replace function public.my_member_in_room(p_room uuid, p_joined_only boolean default true)
returns uuid language sql stable security definer set search_path = public as $$
  select rm.member_id from room_members rm join members m on m.id = rm.member_id
  where rm.room_id = p_room and m.user_id = auth.uid()
    and (not p_joined_only or rm.status = 'joined')
$$;

-- ─────────────────────────────────────────────
-- 맛집 풀
-- ─────────────────────────────────────────────

create or replace function public.add_place(p_group uuid, p_name text, p_category text, p_area text, p_url text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_me uuid; v_id uuid;
begin
  select id into v_me from members where group_id = p_group and user_id = auth.uid();
  if v_me is null then raise exception 'not a member'; end if;
  insert into places (group_id, name, category, area, url, added_by)
    values (p_group, trim(p_name), nullif(trim(p_category), ''), nullif(trim(p_area), ''), nullif(trim(p_url), ''), v_me)
    returning id into v_id;
  insert into place_hearts (place_id, member_id) values (v_id, v_me);
  return v_id;
end $$;

create or replace function public.delete_place(p_place uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from places p join members m on m.id = p.added_by
    where p.id = p_place and m.user_id = auth.uid()
  ) then raise exception 'only the person who added it'; end if;
  delete from places where id = p_place;
end $$;

create or replace function public.toggle_heart(p_place uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_me uuid;
begin
  select m.id into v_me from places p join members m on m.group_id = p.group_id
    where p.id = p_place and m.user_id = auth.uid();
  if v_me is null then raise exception 'not a member'; end if;
  if exists (select 1 from place_hearts where place_id = p_place and member_id = v_me) then
    delete from place_hearts where place_id = p_place and member_id = v_me;
    return false;
  end if;
  insert into place_hearts (place_id, member_id) values (p_place, v_me);
  return true;
end $$;

-- 맛집 목록: 하트 수와 내 하트 여부 (누가 눌렀는지는 안 알려줘요)
create or replace function public.place_list(p_group uuid)
returns table (id uuid, name text, category text, area text, url text, hearts int, mine boolean, added_by_me boolean)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.category, p.area, p.url,
         (select count(*)::int from place_hearts h where h.place_id = p.id),
         exists (select 1 from place_hearts h join members m on m.id = h.member_id
                 where h.place_id = p.id and m.user_id = auth.uid()),
         exists (select 1 from members m where m.id = p.added_by and m.user_id = auth.uid())
  from places p
  where p.group_id = p_group and public.is_group_member(p_group)
  order by 6 desc, p.created_at desc
$$;

-- ─────────────────────────────────────────────
-- 방 안: 시간 투표와 식당
-- ─────────────────────────────────────────────

create or replace function public.vote_time(p_room uuid, p_label text)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms; v_me uuid;
begin
  select * into r from rooms where id = p_room;
  v_me := my_member_in_room(p_room, true);
  if v_me is null then raise exception 'join first'; end if;
  if r.kind <> 'auto' or r.status <> 'confirmed' or r.finalized then raise exception 'voting closed'; end if;
  if not (p_label = any (time_options(r.slot))) then raise exception 'bad time'; end if;
  insert into time_votes (room_id, member_id, label) values (p_room, v_me, p_label)
    on conflict (room_id, member_id) do update set label = excluded.label;
end $$;

create or replace function public.room_time_counts(p_room uuid)
returns table (label text, votes int)
language sql stable security definer set search_path = public as $$
  select o.label, (select count(*)::int from time_votes v
                   join room_members rm on rm.room_id = v.room_id and rm.member_id = v.member_id and rm.status = 'joined'
                   where v.room_id = p_room and v.label = o.label)
  from rooms r, unnest(time_options(r.slot)) with ordinality as o(label, n)
  where r.id = p_room and public.is_room_invitee(p_room)
  order by o.n
$$;

-- 이 방 참석자들의 하트 순위
create or replace function public.room_place_ranking(p_room uuid)
returns table (id uuid, name text, category text, area text, url text, hearts int, mine boolean, tie_votes int)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.category, p.area, p.url,
         (select count(*)::int from place_hearts h
            join room_members rm on rm.member_id = h.member_id and rm.room_id = r.id and rm.status = 'joined'
            where h.place_id = p.id),
         exists (select 1 from place_hearts h join members m on m.id = h.member_id
                 where h.place_id = p.id and m.user_id = auth.uid()),
         (select count(*)::int from tie_votes t where t.room_id = r.id and t.place_id = p.id)
  from rooms r join places p on p.group_id = r.group_id
  where r.id = p_room and public.is_room_invitee(p_room)
  order by 6 desc, p.created_at
$$;

create or replace function public.set_room_place(p_room uuid, p_place uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms;
begin
  select * into r from rooms where id = p_room;
  if my_member_in_room(p_room, true) is null then raise exception 'join first'; end if;
  if not exists (select 1 from places where id = p_place and group_id = r.group_id) then raise exception 'unknown place'; end if;
  update rooms set place_id = p_place, tie_place_ids = null, tie_deadline = null where id = p_room;
end $$;

create or replace function public.vote_tie(p_room uuid, p_place uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms; v_me uuid;
begin
  select * into r from rooms where id = p_room;
  v_me := my_member_in_room(p_room, true);
  if v_me is null then raise exception 'join first'; end if;
  if r.tie_place_ids is null or not (p_place = any (r.tie_place_ids)) or r.tie_deadline < now() then
    raise exception 'voting closed';
  end if;
  insert into tie_votes (room_id, member_id, place_id) values (p_room, v_me, p_place)
    on conflict (room_id, member_id) do update set place_id = excluded.place_id;
end $$;

-- ─────────────────────────────────────────────
-- 마감 처리 (앱을 열 때와 정리 작업에서 실행)
-- ─────────────────────────────────────────────

create or replace function public.finalize_room(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r rooms;
  v_opts text[];
  v_time text;
  v_top int;
  v_ids uuid[];
  v_pick uuid;
begin
  select * into r from rooms where id = p_room for update;
  if r.id is null or r.status <> 'confirmed' then return; end if;

  -- 1) 동표 최종 하트 마감
  if r.tie_place_ids is not null and r.tie_deadline < now() then
    select t.pid into v_pick from (
      select p.pid, (select count(*) from tie_votes v where v.room_id = r.id and v.place_id = p.pid) as votes, p.n
      from unnest(r.tie_place_ids) with ordinality as p(pid, n)
    ) t order by t.votes desc, t.n limit 1;
    update rooms set place_id = v_pick, tie_place_ids = null, tie_deadline = null where id = r.id;
    return;
  end if;

  -- 2) 시간·식당 투표 마감 (자동 방만, 한 번만)
  if r.kind <> 'auto' or r.finalized or vote_deadline_of(r.day) > now() then return; end if;

  v_opts := time_options(r.slot);
  select o.label into v_time
  from unnest(v_opts) with ordinality as o(label, n)
  left join (
    select v.label, count(*) as c from time_votes v
    join room_members rm on rm.room_id = v.room_id and rm.member_id = v.member_id and rm.status = 'joined'
    where v.room_id = r.id group by v.label
  ) c on c.label = o.label
  order by coalesce(c.c, 0) desc, (o.n = 2) desc, o.n
  limit 1;

  update rooms set time_label = v_time, finalized = true where id = r.id;

  if r.place_id is not null then return; end if;

  select max(x.hearts) into v_top from room_place_ranking_internal(r.id) x;
  if coalesce(v_top, 0) = 0 then return; end if;
  select array_agg(x.id order by x.created_at) into v_ids
    from room_place_ranking_internal(r.id) x where x.hearts = v_top;

  if array_length(v_ids, 1) = 1 then
    update rooms set place_id = v_ids[1] where id = r.id;
  else
    update rooms set tie_place_ids = v_ids, tie_deadline = now() + interval '1 day' where id = r.id;
  end if;
end $$;

create or replace function public.room_place_ranking_internal(p_room uuid)
returns table (id uuid, hearts int, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id,
         (select count(*)::int from place_hearts h
            join room_members rm on rm.member_id = h.member_id and rm.room_id = r.id and rm.status = 'joined'
            where h.place_id = p.id),
         p.created_at
  from rooms r join places p on p.group_id = r.group_id
  where r.id = p_room
$$;

create or replace function public.finalize_due(p_group uuid)
returns void language plpgsql security definer set search_path = public as $$
declare x record;
begin
  for x in
    select id from rooms
    where group_id = p_group and status = 'confirmed'
      and ((kind = 'auto' and not finalized and vote_deadline_of(day) <= now())
           or (tie_place_ids is not null and tie_deadline < now()))
  loop
    perform finalize_room(x.id);
  end loop;
end $$;

-- 앱을 열 때 부르는 확인 함수에 마감 처리도 더해요
create or replace function public.recheck_rooms_internal(p_group uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_today date := seoul_today();
  s record;
  v_before int;
  v_after int;
begin
  select count(*) into v_before from rooms where group_id = p_group;
  for s in
    select distinct a.day, a.slot from availability a
    where a.group_id = p_group and a.day between v_today + 8 and v_today + 14
  loop
    perform check_auto_room(p_group, s.day, s.slot);
  end loop;
  perform finalize_due(p_group);
  select count(*) into v_after from rooms where group_id = p_group;
  return v_after - v_before;
end $$;

-- ─────────────────────────────────────────────
-- 권한
-- ─────────────────────────────────────────────

revoke execute on function
  public.time_options(text), public.vote_deadline_of(date), public.my_member_in_room(uuid, boolean),
  public.add_place(uuid, text, text, text, text), public.delete_place(uuid), public.toggle_heart(uuid),
  public.place_list(uuid), public.vote_time(uuid, text), public.room_time_counts(uuid),
  public.room_place_ranking(uuid), public.set_room_place(uuid, uuid), public.vote_tie(uuid, uuid),
  public.finalize_room(uuid), public.room_place_ranking_internal(uuid), public.finalize_due(uuid)
from public, anon;

grant execute on function
  public.add_place(uuid, text, text, text, text), public.delete_place(uuid), public.toggle_heart(uuid),
  public.place_list(uuid), public.vote_time(uuid, text), public.room_time_counts(uuid),
  public.room_place_ranking(uuid), public.set_room_place(uuid, uuid), public.vote_tie(uuid, uuid),
  public.time_options(text), public.vote_deadline_of(date)
to authenticated;

revoke execute on function
  public.my_member_in_room(uuid, boolean), public.finalize_room(uuid),
  public.room_place_ranking_internal(uuid), public.finalize_due(uuid)
from authenticated;

alter publication supabase_realtime add table public.places;
