-- 49th 첫 버전 데이터베이스
-- Supabase 대시보드 > SQL Editor에 이 파일 전체를 붙여넣고 Run 하면 돼요.
-- 시간 기준은 한국 시간(Asia/Seoul)이에요.

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────
-- 테이블
-- ─────────────────────────────────────────────

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 30),
  code text not null unique check (code ~ '^[0-9]{6}$'),
  threshold int not null default 3 check (threshold between 2 and 7),
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 20),
  color text not null default '#DCEBFF' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  birthday text check (birthday is null or char_length(birthday) <= 20),
  created_at timestamptz not null default now(),
  unique (group_id, user_id)
);

-- 내가 될 수도 있다고 칠한 시간 (L = 점심, D = 저녁)
create table public.availability (
  member_id uuid not null references public.members(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  day date not null,
  slot text not null check (slot in ('L', 'D')),
  created_at timestamptz not null default now(),
  primary key (member_id, day, slot)
);
create index availability_slot_idx on public.availability (group_id, day, slot);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  kind text not null check (kind in ('auto', 'manual')),
  title text check (title is null or char_length(title) <= 30),
  day date not null,
  slot text not null check (slot in ('L', 'D')),
  time_label text,
  status text not null default 'open' check (status in ('open', 'confirmed')),
  reply_deadline timestamptz not null,
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index rooms_auto_unique on public.rooms (group_id, day, slot) where kind = 'auto';

create table public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  status text not null default 'invited' check (status in ('invited', 'joined', 'passed')),
  updated_at timestamptz not null default now(),
  primary key (room_id, member_id)
);
create index room_members_member_idx on public.room_members (member_id);

-- 누군가 X로 없앤 자동 방: 같은 날·시간대에 다시 생기지 않게 기록
create table public.dismissed_slots (
  group_id uuid not null references public.groups(id) on delete cascade,
  day date not null,
  slot text not null check (slot in ('L', 'D')),
  primary key (group_id, day, slot)
);

-- ─────────────────────────────────────────────
-- 도우미 함수 (보안 규칙에서 사용)
-- ─────────────────────────────────────────────

create or replace function public.seoul_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Seoul')::date $$;

create or replace function public.is_group_member(gid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where group_id = gid and user_id = auth.uid())
$$;

create or replace function public.is_my_member(mid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where id = mid and user_id = auth.uid())
$$;

create or replace function public.is_room_invitee(rid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from room_members rm join members m on m.id = rm.member_id
    where rm.room_id = rid and m.user_id = auth.uid()
  )
$$;

-- ─────────────────────────────────────────────
-- 보안 규칙: 내가 속한 것만 보여요
-- ─────────────────────────────────────────────

alter table public.groups enable row level security;
alter table public.members enable row level security;
alter table public.availability enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.dismissed_slots enable row level security;

create policy groups_read on public.groups for select to authenticated
  using (public.is_group_member(id));

create policy members_read on public.members for select to authenticated
  using (public.is_group_member(group_id));
create policy members_update_self on public.members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 칠한 시간은 본인 것만 직접 읽어요. 친구 수는 availability_counts()로 숫자만 받아요.
create policy availability_read_own on public.availability for select to authenticated
  using (public.is_my_member(member_id));
create policy availability_insert_own on public.availability for insert to authenticated
  with check (
    public.is_my_member(member_id)
    and group_id = (select m.group_id from public.members m where m.id = member_id)
  );
create policy availability_delete_own on public.availability for delete to authenticated
  using (public.is_my_member(member_id));

-- 방은 초대받은 사람만, 응답 마감이 지난 미확정 방은 아무에게도 안 보여요
create policy rooms_read on public.rooms for select to authenticated
  using (
    public.is_room_invitee(id)
    and not (status = 'open' and reply_deadline < now())
  );

-- 패스는 본인에게만 보여요
create policy room_members_read on public.room_members for select to authenticated
  using (
    public.is_room_invitee(room_id)
    and (status <> 'passed' or public.is_my_member(member_id))
  );

-- 직접 쓰기는 막고, 아래 함수로만 바꿔요
revoke insert, update, delete on public.groups, public.rooms, public.room_members, public.dismissed_slots from anon, authenticated;
revoke all on public.groups, public.members, public.availability, public.rooms, public.room_members, public.dismissed_slots from anon;
revoke update on public.members from authenticated;
grant update (name, color, birthday) on public.members to authenticated;
revoke insert, delete on public.members from authenticated;

-- ─────────────────────────────────────────────
-- 그룹 만들기·참여·기준 인원
-- ─────────────────────────────────────────────

create or replace function public.create_group(p_group_name text, p_threshold int, p_my_name text, p_color text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_code text;
  v_gid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  loop
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from groups where code = v_code);
  end loop;
  insert into groups (name, code, threshold, owner_id)
    values (trim(p_group_name), v_code, p_threshold, auth.uid())
    returning id into v_gid;
  insert into members (group_id, user_id, name, color)
    values (v_gid, auth.uid(), trim(p_my_name), p_color);
  return v_gid;
end $$;

-- 초대 번호 확인 (참여 전 미리보기): 그룹 이름과 인원만 알려줘요
create or replace function public.peek_group(p_code text)
returns table (name text, owner_name text, member_count int)
language sql stable security definer set search_path = public as $$
  select g.name,
         (select m.name from members m where m.group_id = g.id and m.user_id = g.owner_id),
         (select count(*)::int from members m where m.group_id = g.id)
  from groups g where g.code = p_code
$$;

create or replace function public.join_group(p_code text, p_my_name text, p_color text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_gid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select id into v_gid from groups where code = p_code;
  if v_gid is null then raise exception 'wrong code'; end if;
  if exists (select 1 from members where group_id = v_gid and user_id = auth.uid()) then
    return v_gid;
  end if;
  if (select count(*) from members where group_id = v_gid) >= 8 then
    raise exception 'group full';
  end if;
  insert into members (group_id, user_id, name, color)
    values (v_gid, auth.uid(), trim(p_my_name), p_color);
  return v_gid;
end $$;

create or replace function public.set_threshold(p_group uuid, p_threshold int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from groups where id = p_group and owner_id = auth.uid()) then
    raise exception 'only the owner can change this';
  end if;
  update groups set threshold = p_threshold where id = p_group;
end $$;

create or replace function public.leave_group(p_group uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from members where group_id = p_group and user_id = auth.uid();
end $$;

-- ─────────────────────────────────────────────
-- 칠하기 → 방 자동 생성
-- 자동 방은 오늘로부터 8~14일 뒤 날짜에만 생겨요
-- (응답 3일 + 시간 투표는 모임 5일 전 마감)
-- ─────────────────────────────────────────────

create or replace function public.check_auto_room(p_group uuid, p_day date, p_slot text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_today date := seoul_today();
  v_threshold int;
  v_count int;
  v_rid uuid;
begin
  if p_day < v_today + 8 or p_day > v_today + 14 then return; end if;
  if exists (select 1 from dismissed_slots where group_id = p_group and day = p_day and slot = p_slot) then
    return;
  end if;

  select id into v_rid from rooms
    where group_id = p_group and day = p_day and slot = p_slot and kind = 'auto';

  if v_rid is null then
    select threshold into v_threshold from groups where id = p_group;
    select count(*) into v_count from availability
      where group_id = p_group and day = p_day and slot = p_slot;
    if v_count < v_threshold then return; end if;
    insert into rooms (group_id, kind, day, slot, reply_deadline)
      values (p_group, 'auto', p_day, p_slot, now() + interval '3 days')
      on conflict do nothing
      returning id into v_rid;
    if v_rid is null then return; end if;
  end if;

  -- 그 시간대를 칠한 사람은 모두 초대 (나중에 칠한 사람도)
  insert into room_members (room_id, member_id)
    select v_rid, a.member_id from availability a
    where a.group_id = p_group and a.day = p_day and a.slot = p_slot
    on conflict do nothing;
end $$;

create or replace function public.on_availability_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform check_auto_room(new.group_id, new.day, new.slot);
  return new;
end $$;

create trigger availability_after_insert
  after insert on public.availability
  for each row execute function public.on_availability_insert();

-- 캘린더에 보여줄 친구 수 (나를 뺀 숫자만)
create or replace function public.availability_counts(p_group uuid, p_from date, p_to date)
returns table (day date, slot text, others int)
language sql stable security definer set search_path = public as $$
  select a.day, a.slot, count(*)::int
  from availability a
  join members m on m.id = a.member_id
  where a.group_id = p_group
    and public.is_group_member(p_group)
    and a.day between p_from and p_to
    and m.user_id <> auth.uid()
  group by a.day, a.slot
$$;

-- 첫날 홈: 누가 들어왔고 누가 칠했는지
create or replace function public.group_progress(p_group uuid)
returns table (member_id uuid, name text, color text, painted boolean, is_owner boolean, is_me boolean)
language sql stable security definer set search_path = public as $$
  select m.id, m.name, m.color,
         exists (select 1 from availability a where a.member_id = m.id and a.day >= seoul_today()),
         m.user_id = g.owner_id,
         m.user_id = auth.uid()
  from members m join groups g on g.id = m.group_id
  where m.group_id = p_group and public.is_group_member(p_group)
  order by m.created_at
$$;

-- ─────────────────────────────────────────────
-- 참석·패스·취소·없애기
-- ─────────────────────────────────────────────

create or replace function public.delete_room_internal(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r rooms;
begin
  select * into r from rooms where id = p_room;
  if r.id is null then return; end if;
  if r.kind = 'auto' then
    insert into dismissed_slots (group_id, day, slot) values (r.group_id, r.day, r.slot)
      on conflict do nothing;
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

  -- 확정된 모임에서 빠지면 방이 없어져요
  if r.status = 'confirmed' and v_old = 'joined' and p_status <> 'joined' then
    perform delete_room_internal(p_room);
    return 'deleted';
  end if;

  if r.status = 'open' and r.reply_deadline < now() then raise exception 'room expired'; end if;

  update room_members set status = p_status, updated_at = now()
    where room_id = p_room and member_id = v_me;

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
begin
  if not exists (
    select 1 from room_members rm join members m on m.id = rm.member_id
    where rm.room_id = p_room and m.user_id = auth.uid() and rm.status <> 'passed'
  ) then
    raise exception 'not allowed';
  end if;
  perform delete_room_internal(p_room);
end $$;

-- 직접 만드는 방: 초대한 사람이 모두 참석해야 확정
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

  -- 응답 마감: 3일 뒤와 모임 날 밤 12시 중 빠른 쪽
  v_deadline := least(now() + interval '3 days', ((p_day + 1)::timestamp at time zone 'Asia/Seoul'));

  insert into rooms (group_id, kind, title, day, slot, time_label, reply_deadline, created_by)
    values (p_group, 'manual', nullif(trim(p_title), ''), p_day, p_slot, p_time, v_deadline, v_me)
    returning id into v_rid;
  insert into room_members (room_id, member_id, status) values (v_rid, v_me, 'joined');
  insert into room_members (room_id, member_id)
    select v_rid, i from unnest(p_invitees) i where i <> v_me
    on conflict do nothing;
  return v_rid;
end $$;

-- ─────────────────────────────────────────────
-- 정리 작업: 응답 마감이 지난 미확정 방 지우기
-- (보이는 건 이미 규칙으로 막혀 있어서, 이건 청소용이에요)
-- ─────────────────────────────────────────────

create or replace function public.cleanup_rooms()
returns void language sql security definer set search_path = public as $$
  delete from rooms where status = 'open' and reply_deadline < now();
  delete from dismissed_slots where day < seoul_today();
  delete from availability where day < seoul_today() - 1;
$$;

-- ─────────────────────────────────────────────
-- 함수 실행 권한
-- ─────────────────────────────────────────────

revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.create_group(text, int, text, text),
  public.peek_group(text),
  public.join_group(text, text, text),
  public.set_threshold(uuid, int),
  public.leave_group(uuid),
  public.availability_counts(uuid, date, date),
  public.group_progress(uuid),
  public.respond_room(uuid, text),
  public.delete_room(uuid),
  public.create_manual_room(uuid, text, date, text, text, uuid[]),
  public.is_group_member(uuid),
  public.is_my_member(uuid),
  public.is_room_invitee(uuid),
  public.seoul_today()
to authenticated;
revoke execute on function public.check_auto_room(uuid, date, text), public.delete_room_internal(uuid), public.cleanup_rooms() from authenticated;
-- 서버 잠들기 방지용(GitHub Actions가 하루 한 번 호출): 오늘 날짜만 알려주는 무해한 함수
grant execute on function public.seoul_today() to anon;

-- 실시간 동기화
alter publication supabase_realtime add table public.rooms, public.room_members;
