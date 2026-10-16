-- 0004: 푸시 알림
-- Supabase SQL Editor에서 새 쿼리를 열고 이 파일 내용을 붙여넣은 뒤 Run 하면 돼요.
-- (먼저 README의 "알림 설정" 순서대로 서버 함수 push를 만들어 두세요)
--
-- 동작
--  · 앱에서 일이 생기면(초대장, 확정, 취소, 시간·식당 확정 등) notifications 대기열에 쌓여요
--  · 1분마다 도는 예약 작업 tick()이 마감 처리와 미리 알림을 만들고, 서버 함수 push를 불러 실제로 보내요
--  · 알림 서명 키(VAPID)는 서버 함수가 처음 실행될 때 만들어서 여기 private 영역에만 저장해요

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- ─────────────────────────────────────────────
-- 비공개 설정 (앱에서는 절대 못 읽어요)
-- ─────────────────────────────────────────────
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.settings (
  key text primary key,
  value text not null
);
insert into private.settings (key, value)
  values ('cron_secret', md5(random()::text || clock_timestamp()::text) || md5(random()::text))
  on conflict (key) do nothing;

-- ─────────────────────────────────────────────
-- 테이블
-- ─────────────────────────────────────────────
alter table public.members add column if not exists notify jsonb not null
  default '{"invite": true, "vote": true, "eve": true, "long": true}'::jsonb;
alter table public.members add column if not exists last_nudged_at timestamptz;
grant update (notify) on public.members to authenticated;

alter table public.rooms add column if not exists vote_reminded boolean not null default false;
alter table public.rooms add column if not exists eve_reminded boolean not null default false;

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  member_id uuid not null references public.members(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_subs_read_own on public.push_subscriptions;
create policy push_subs_read_own on public.push_subscriptions for select to authenticated
  using (public.is_my_member(member_id));
revoke all on public.push_subscriptions from anon;
revoke insert, update, delete on public.push_subscriptions from authenticated;

create table if not exists public.notifications (
  id bigserial primary key,
  member_id uuid not null references public.members(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null,
  url text not null default '/',
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  tries int not null default 0
);
create index if not exists notifications_unsent_idx on public.notifications (id) where sent_at is null;
alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;

-- ─────────────────────────────────────────────
-- 글자 도우미
-- ─────────────────────────────────────────────
create or replace function public.kdate(p_day date) returns text
language sql immutable as $$
  select extract(month from p_day)::int || '월 ' || extract(day from p_day)::int || '일('
         || (array['일','월','화','수','목','금','토'])[extract(dow from p_day)::int + 1] || ')'
$$;

create or replace function public.kslot(p_slot text) returns text
language sql immutable as $$ select case p_slot when 'L' then '점심' else '저녁' end $$;

-- ─────────────────────────────────────────────
-- 대기열에 넣기 (각자 알림 설정을 지켜요)
-- 종류 → 설정: invite(초대장·확정·취소), vote(투표·시간·식당), eve(모임 전날), long(오랜만)
-- ─────────────────────────────────────────────
create or replace function public.enqueue(p_member uuid, p_pref text, p_title text, p_body text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from members m
    where m.id = p_member and coalesce((m.notify ->> p_pref)::boolean, true)
  ) then
    insert into notifications (member_id, kind, title, body) values (p_member, p_pref, p_title, p_body);
  end if;
end $$;

create or replace function public.enqueue_joined(p_room uuid, p_pref text, p_title text, p_body text, p_except_user uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare x record;
begin
  for x in
    select rm.member_id from room_members rm join members m on m.id = rm.member_id
    where rm.room_id = p_room and rm.status = 'joined'
      and (p_except_user is null or m.user_id <> p_except_user)
  loop
    perform enqueue(x.member_id, p_pref, p_title, p_body);
  end loop;
end $$;


-- 시간·식당 마감을 한 번에 저장하도록 바꿔요 (알림이 한 번만 가게)
create or replace function public.finalize_room(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r rooms;
  v_time text;
  v_top int;
  v_ids uuid[];
  v_pick uuid;
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

  -- 시간·식당 투표 마감 (자동 방만, 한 번만)
  if r.kind <> 'auto' or r.finalized or vote_deadline_of(r.day) > now() then return; end if;

  select o.label into v_time
  from unnest(time_options(r.slot)) with ordinality as o(label, n)
  left join (
    select v.label, count(*) as c from time_votes v
    join room_members rm on rm.room_id = v.room_id and rm.member_id = v.member_id and rm.status = 'joined'
    where v.room_id = r.id group by v.label
  ) c on c.label = o.label
  order by coalesce(c.c, 0) desc, (o.n = 2) desc, o.n
  limit 1;

  if r.place_id is null then
    select max(x.hearts) into v_top from room_place_ranking_internal(r.id) x;
    if coalesce(v_top, 0) > 0 then
      select array_agg(x.id order by x.created_at) into v_ids
        from room_place_ranking_internal(r.id) x where x.hearts = v_top;
    end if;
  end if;

  update rooms set
    time_label = v_time,
    finalized = true,
    place_id = case when r.place_id is null and array_length(v_ids, 1) = 1 then v_ids[1] else place_id end,
    tie_place_ids = case when r.place_id is null and array_length(v_ids, 1) > 1 then v_ids else tie_place_ids end,
    tie_deadline = case when r.place_id is null and array_length(v_ids, 1) > 1 then now() + interval '1 day' else tie_deadline end
  where id = r.id;
end $$;

-- ─────────────────────────────────────────────
-- 이벤트 → 알림
-- ─────────────────────────────────────────────

-- 초대장
create or replace function public.notify_invite()
returns trigger language plpgsql security definer set search_path = public as $$
declare r rooms; v_from text;
begin
  if new.status <> 'invited' then return new; end if;
  select * into r from rooms where id = new.room_id;
  if r.kind = 'auto' then
    perform enqueue(new.member_id, 'invite', '새 초대장',
      kdate(r.day) || ' ' || kslot(r.slot) || ', 여러 명이 될 수도 있대요. 참석할래요?');
  else
    select name into v_from from members where id = r.created_by;
    perform enqueue(new.member_id, 'invite', coalesce(v_from, '친구') || '님의 초대',
      coalesce(r.title || ' · ', '') || kdate(r.day) || ' ' || coalesce(r.time_label, kslot(r.slot)));
  end if;
  return new;
end $$;

drop trigger if exists room_members_notify_invite on public.room_members;
create trigger room_members_notify_invite
  after insert on public.room_members
  for each row execute function public.notify_invite();

-- 확정, 시간·식당, 동표
create or replace function public.notify_room_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_place text; v_when text;
begin
  v_when := kdate(new.day) || ' ' || coalesce(new.time_label, kslot(new.slot));
  select name into v_place from places where id = new.place_id;

  if old.status = 'open' and new.status = 'confirmed' then
    perform enqueue_joined(new.id, 'invite', '모임 확정!',
      v_when || case when new.kind = 'auto' then ' · 시간과 식당을 정해주세요' else '' end);
  end if;

  if not old.finalized and new.finalized then
    perform enqueue_joined(new.id, 'vote', '시간이 정해졌어요',
      v_when || coalesce(' · ' || v_place, case when new.tie_place_ids is null then ' · 식당은 아직 미정' else ' · 식당은 최종 하트로 정해요' end));
  elsif new.place_id is not null and new.place_id is distinct from old.place_id then
    perform enqueue_joined(new.id, 'vote', '식당이 정해졌어요', v_when || ' · ' || v_place, auth.uid());
  end if;

  if old.tie_place_ids is null and new.tie_place_ids is not null then
    perform enqueue_joined(new.id, 'vote', '식당 하트가 똑같이 나왔어요',
      kdate(new.day) || ' 모임 · 내일까지 최종 하트를 하나 골라주세요');
  end if;
  return new;
end $$;

drop trigger if exists rooms_notify_update on public.rooms;
create trigger rooms_notify_update
  after update on public.rooms
  for each row execute function public.notify_room_update();

-- 확정된 모임이 없어지면
create or replace function public.notify_room_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'confirmed' then
    perform enqueue_joined(old.id, 'invite', '모임이 취소됐어요',
      coalesce(old.title || ' · ', '') || kdate(old.day) || ' ' || kslot(old.slot), auth.uid());
  end if;
  return old;
end $$;

drop trigger if exists rooms_notify_delete on public.rooms;
create trigger rooms_notify_delete
  before delete on public.rooms
  for each row execute function public.notify_room_delete();

-- ─────────────────────────────────────────────
-- 앱에서 부르는 함수
-- ─────────────────────────────────────────────

-- 알림 공개 키 (서버 함수가 처음 실행된 뒤부터 생겨요)
create or replace function public.push_public_key() returns text
language sql stable security definer set search_path = public, private as $$
  select value from private.settings where key = 'vapid_app_key'
$$;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid;
begin
  select id into v_me from members where user_id = auth.uid() order by created_at limit 1;
  if v_me is null then raise exception 'not a member'; end if;
  if p_endpoint !~ '^https://' then raise exception 'bad endpoint'; end if;
  insert into push_subscriptions (endpoint, member_id, p256dh, auth)
    values (p_endpoint, v_me, p_p256dh, p_auth)
    on conflict (endpoint) do update set member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from push_subscriptions s using members m
  where s.endpoint = p_endpoint and m.id = s.member_id and m.user_id = auth.uid();
end $$;

-- ─────────────────────────────────────────────
-- 서버 함수(push) 전용 — service_role만 실행
-- ─────────────────────────────────────────────
create or replace function public.push_check_secret(p_secret text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from private.settings where key = 'cron_secret' and value = p_secret and length(p_secret) > 20)
$$;

create or replace function public.push_get_vapid() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when count(*) = 2 then jsonb_build_object(
    'public_jwk', (select value::jsonb from private.settings where key = 'vapid_public_jwk'),
    'private_jwk', (select value::jsonb from private.settings where key = 'vapid_private_jwk')) end
  from private.settings where key in ('vapid_public_jwk', 'vapid_private_jwk')
$$;

create or replace function public.push_set_vapid(p_public jsonb, p_private jsonb, p_app_key text)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  if exists (select 1 from private.settings where key = 'vapid_private_jwk') then return; end if;
  insert into private.settings (key, value) values
    ('vapid_public_jwk', p_public::text),
    ('vapid_private_jwk', p_private::text),
    ('vapid_app_key', p_app_key)
  on conflict (key) do nothing;
end $$;

-- 보낼 알림 꺼내기: (알림 × 그 사람의 기기) 한 줄씩
create or replace function public.push_take(p_limit int default 100)
returns table (id bigint, endpoint text, p256dh text, auth text, title text, body text, url text)
language plpgsql security definer set search_path = public as $$
begin
  -- 기기가 하나도 없는 사람의 알림은 보낼 곳이 없으니 정리
  update notifications n set sent_at = now()
  where n.sent_at is null and not exists (select 1 from push_subscriptions s where s.member_id = n.member_id);
  -- 너무 오래되었거나 계속 실패한 알림 정리
  update notifications n set sent_at = now()
  where n.sent_at is null and (n.tries >= 5 or n.created_at < now() - interval '1 day');

  return query
    select n.id, s.endpoint, s.p256dh, s.auth, n.title, n.body, n.url
    from (select * from notifications where sent_at is null order by notifications.id limit p_limit) n
    join push_subscriptions s on s.member_id = n.member_id;
end $$;

create or replace function public.push_done(p_ids bigint[]) returns void
language sql security definer set search_path = public as $$
  update notifications set sent_at = now() where id = any (p_ids)
$$;

create or replace function public.push_fail(p_ids bigint[]) returns void
language sql security definer set search_path = public as $$
  update notifications set tries = tries + 1 where id = any (p_ids)
$$;

create or replace function public.push_drop_subscription(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint
$$;

-- ─────────────────────────────────────────────
-- 1분마다 도는 작업
-- ─────────────────────────────────────────────
create or replace function public.tick()
returns void language plpgsql security definer set search_path = public, private, extensions as $$
declare
  v_now_kst timestamp := now() at time zone 'Asia/Seoul';
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  r record;
  x record;
  v_secret text;
begin
  -- 마감 지난 방 정리, 새로 창에 들어온 시간 확인, 시간·식당 마감 처리
  perform cleanup_rooms();

  -- 시간 투표 마감 하루 전: 아직 안 고른 참석자에게
  for r in
    select * from rooms
    where kind = 'auto' and status = 'confirmed' and not finalized and not vote_reminded
      and vote_deadline_of(day) > now() and vote_deadline_of(day) - now() < interval '24 hours'
  loop
    for x in
      select rm.member_id from room_members rm
      where rm.room_id = r.id and rm.status = 'joined'
        and not exists (select 1 from time_votes v where v.room_id = r.id and v.member_id = rm.member_id)
    loop
      perform enqueue(x.member_id, 'vote', '시간 투표 마감 하루 전',
        kdate(r.day) || ' 모임, ' || case when (vote_deadline_of(r.day) at time zone 'Asia/Seoul')::date = v_today then '오늘' else '내일' end || ' 밤 9시까지 몇 시가 좋은지 골라주세요');
    end loop;
    update rooms set vote_reminded = true where id = r.id;
  end loop;

  -- 모임 전날 저녁 7시
  if extract(hour from v_now_kst) >= 19 then
    for r in
      select * from rooms where status = 'confirmed' and not eve_reminded and day = v_today + 1
    loop
      perform enqueue_joined(r.id, 'eve', '내일 모임이에요',
        coalesce(r.title || ' · ', '') || coalesce(r.time_label, kslot(r.slot))
        || coalesce(' · ' || (select name from places where id = r.place_id), ''));
      update rooms set eve_reminded = true where id = r.id;
    end loop;
  end if;

  -- 오랜만 알림: 저녁 7시, 마지막 모임에서 25일 넘게 지났고 잡힌 약속이 없으면 (30일에 한 번)
  if extract(hour from v_now_kst) = 19 then
    for x in
      select m.id from members m
      where (m.last_nudged_at is null or m.last_nudged_at < now() - interval '30 days')
        and m.created_at < now() - interval '25 days'
        and not exists (
          select 1 from room_members rm join rooms ro on ro.id = rm.room_id
          where rm.member_id = m.id and rm.status = 'joined' and ro.day >= v_today - 25)
    loop
      perform enqueue(x.id, 'long', '오랜만이에요',
        '다 같이 본 지 곧 한 달이에요. 되는 날을 칠해볼까요?');
      update members set last_nudged_at = now() where id = x.id;
    end loop;
  end if;

  -- 보낼 알림이 있거나 알림 키가 아직 없으면 서버 함수 호출
  if exists (select 1 from notifications where sent_at is null)
     or not exists (select 1 from private.settings where key = 'vapid_app_key') then
    select value into v_secret from private.settings where key = 'cron_secret';
    perform net.http_post(
      url := 'https://sfvapctbkcvixijozrgy.supabase.co/functions/v1/push',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
      body := '{}'::jsonb
    );
  end if;
end $$;

-- ─────────────────────────────────────────────
-- 권한
-- ─────────────────────────────────────────────
revoke execute on function
  public.kdate(date), public.kslot(text), public.enqueue(uuid, text, text, text),
  public.enqueue_joined(uuid, text, text, text, uuid), public.push_public_key(),
  public.save_push_subscription(text, text, text), public.remove_push_subscription(text),
  public.push_check_secret(text), public.push_get_vapid(), public.push_set_vapid(jsonb, jsonb, text),
  public.push_take(int), public.push_done(bigint[]), public.push_fail(bigint[]),
  public.push_drop_subscription(text), public.tick()
from public, anon, authenticated;

grant execute on function public.push_public_key(), public.save_push_subscription(text, text, text),
  public.remove_push_subscription(text)
to authenticated;

grant execute on function public.push_check_secret(text), public.push_get_vapid(),
  public.push_set_vapid(jsonb, jsonb, text), public.push_take(int), public.push_done(bigint[]),
  public.push_fail(bigint[]), public.push_drop_subscription(text)
to service_role;

-- 1분마다 실행 (같은 이름이 있으면 바꿔요)
select cron.schedule('49th-tick', '* * * * *', 'select public.tick()');
