-- 0013: 방 대화
-- Supabase SQL Editor에서 새 쿼리를 열고 이 파일 내용을 붙여넣은 뒤 Run 하면 돼요.
--
--  · 참석한 사람만 읽고 쓸 수 있어요 (패스·참석 취소·내보내진 사람은 그 순간부터 못 봐요)
--  · 글자 메시지(500자까지)와 맛집 카드. 내가 쓴 메시지는 지울 수 있어요
--  · 확정·시간·식당·투표 마감 같은 일은 대화에 자동 안내로 올라와요
--  · 알림: 아직 안 보낸 대화 알림이 있으면 "새 메시지 n개"로 묶어요. 방마다 끌 수 있고, 설정의 '대화'로 전체를 끌 수도 있어요
--  · 방이 없어지면 대화도 지워지고, 모임 날짜 일주일 뒤에 자동으로 정리돼요

create table if not exists public.messages (
  id bigserial primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  member_id uuid references public.members(id) on delete set null,
  kind text not null default 'text' check (kind in ('text', 'place', 'system')),
  body text check (body is null or char_length(body) <= 500),
  place_id uuid references public.places(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists messages_room_idx on public.messages (room_id, id);

create table if not exists public.room_reads (
  room_id uuid not null references public.rooms(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  last_read_id bigint not null default 0,
  muted boolean not null default false,
  primary key (room_id, member_id)
);

alter table public.notifications add column if not exists room_id uuid references public.rooms(id) on delete cascade;

-- 이 방에 참석한 내 멤버 id
create or replace function public.my_joined_member(p_room uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select rm.member_id from room_members rm join members m on m.id = rm.member_id
  where rm.room_id = p_room and rm.status = 'joined' and m.user_id = auth.uid()
$$;

alter table public.messages enable row level security;
alter table public.room_reads enable row level security;
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated
  using (public.my_joined_member(room_id) is not null);
drop policy if exists room_reads_own on public.room_reads;
create policy room_reads_own on public.room_reads for select to authenticated
  using (public.is_my_member(member_id));
revoke insert, update, delete on public.messages, public.room_reads from anon, authenticated;
revoke all on public.messages, public.room_reads from anon;

-- 실시간으로 받기
do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────
-- 보내기·지우기·읽음·끄기
-- ─────────────────────────────────────────────
create or replace function public.send_message(p_room uuid, p_body text, p_place uuid default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_me uuid;
  v_id bigint;
  v_body text := nullif(trim(coalesce(p_body, '')), '');
begin
  v_me := my_joined_member(p_room);
  if v_me is null then raise exception 'join first'; end if;
  if p_place is not null then
    if not exists (select 1 from places p join rooms r on r.group_id = p.group_id where p.id = p_place and r.id = p_room) then
      raise exception 'unknown place';
    end if;
    insert into messages (room_id, member_id, kind, body, place_id) values (p_room, v_me, 'place', v_body, p_place)
      returning id into v_id;
  else
    if v_body is null then raise exception 'empty message'; end if;
    insert into messages (room_id, member_id, kind, body) values (p_room, v_me, 'text', v_body)
      returning id into v_id;
  end if;
  insert into room_reads (room_id, member_id, last_read_id) values (p_room, v_me, v_id)
    on conflict (room_id, member_id) do update set last_read_id = greatest(room_reads.last_read_id, v_id);
  return v_id;
end $$;

create or replace function public.delete_message(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from messages m using members me
  where m.id = p_id and me.id = m.member_id and me.user_id = auth.uid() and m.kind <> 'system';
  if not found then raise exception 'not allowed'; end if;
end $$;

create or replace function public.mark_read(p_room uuid, p_last bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid;
begin
  v_me := my_joined_member(p_room);
  if v_me is null then return; end if;
  insert into room_reads (room_id, member_id, last_read_id) values (p_room, v_me, p_last)
    on conflict (room_id, member_id) do update set last_read_id = greatest(room_reads.last_read_id, excluded.last_read_id);
end $$;

create or replace function public.set_room_mute(p_room uuid, p_muted boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid;
begin
  v_me := my_joined_member(p_room);
  if v_me is null then raise exception 'join first'; end if;
  insert into room_reads (room_id, member_id, muted) values (p_room, v_me, p_muted)
    on conflict (room_id, member_id) do update set muted = excluded.muted;
end $$;

-- 내가 참석한 방들의 안 읽은 수 (내 메시지·자동 안내 제외)
create or replace function public.room_unread(p_group uuid)
returns table (room_id uuid, unread int, muted boolean)
language sql stable security definer set search_path = public as $$
  select r.id,
    (select count(*)::int from messages x where x.room_id = r.id and x.id > coalesce(rr.last_read_id, 0)
       and x.kind <> 'system' and x.member_id is distinct from rm.member_id),
    coalesce(rr.muted, false)
  from rooms r
  join room_members rm on rm.room_id = r.id and rm.status = 'joined'
  join members m on m.id = rm.member_id and m.user_id = auth.uid()
  left join room_reads rr on rr.room_id = r.id and rr.member_id = rm.member_id
  where r.group_id = p_group
$$;

-- ─────────────────────────────────────────────
-- 대화 알림 (묶음)
-- ─────────────────────────────────────────────
create or replace function public.notify_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r rooms;
  x record;
  v_from text;
  v_preview text;
  v_title text;
  v_id bigint;
  v_n int;
begin
  if new.kind = 'system' then return new; end if;
  select * into r from rooms where id = new.room_id;
  select name into v_from from members where id = new.member_id;
  v_preview := coalesce(v_from, '친구') || ': ' || case when new.kind = 'place'
    then '맛집을 보냈어요 · ' || coalesce((select name from places where id = new.place_id), '')
    else left(new.body, 60) end;
  v_title := coalesce(r.title, kdate(r.day) || ' ' || coalesce(r.time_label, kslot(r.slot)));

  for x in
    select rm.member_id from room_members rm
    join members m on m.id = rm.member_id
    left join room_reads rr on rr.room_id = r.id and rr.member_id = rm.member_id
    where rm.room_id = r.id and rm.status = 'joined' and rm.member_id is distinct from new.member_id
      and not coalesce(rr.muted, false)
      and coalesce((m.notify ->> 'chat')::boolean, true)
  loop
    select id, coalesce(substring(title from '새 메시지 (\d+)개')::int, 1) into v_id, v_n
      from notifications where member_id = x.member_id and room_id = r.id and kind = 'chat' and sent_at is null
      order by id desc limit 1;
    if v_id is not null then
      update notifications set title = v_title || ' · 새 메시지 ' || (v_n + 1) || '개', body = v_preview where id = v_id;
    else
      insert into notifications (member_id, kind, title, body, room_id)
        values (x.member_id, 'chat', v_title || ' · 새 메시지', v_preview, r.id);
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists messages_notify on public.messages;
create trigger messages_notify after insert on public.messages
  for each row execute function public.notify_message();

-- 알림을 누르면 그 방 대화로 (&c=방)
create or replace function public.push_take(p_limit int default 100)
returns table (id bigint, endpoint text, p256dh text, auth text, title text, body text, url text)
language plpgsql security definer set search_path = public as $$
begin
  update notifications n set sent_at = now()
  from members m
  where n.sent_at is null and m.id = n.member_id
    and not exists (select 1 from push_subscriptions s where s.user_id = m.user_id);
  update notifications n set sent_at = now()
  where n.sent_at is null and (n.tries >= 5 or n.created_at < now() - interval '1 day');

  return query
    select n.id, s.endpoint, s.p256dh, s.auth,
      case when (select count(*) from members x where x.user_id = m.user_id) > 1
        then g.name || ' · ' || n.title else n.title end,
      n.body,
      '/?g=' || m.group_id::text || case when n.room_id is not null then '&c=' || n.room_id::text else '' end
    from (select * from notifications where sent_at is null order by notifications.id limit p_limit) n
    join members m on m.id = n.member_id
    join groups g on g.id = m.group_id
    join push_subscriptions s on s.user_id = m.user_id;
end $$;

-- ─────────────────────────────────────────────
-- 자동 안내 (대화 안에만, 알림은 기존 알림이 따로 가요)
-- ─────────────────────────────────────────────
create or replace function public.system_message(p_room uuid, p_body text)
returns void language sql security definer set search_path = public as $$
  insert into messages (room_id, member_id, kind, body) values (p_room, null, 'system', p_body)
$$;

create or replace function public.chat_room_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_place text;
begin
  select name into v_place from places where id = new.place_id;
  if old.status = 'open' and new.status = 'confirmed' then
    perform system_message(new.id, case when new.kind = 'auto'
      then '모임이 확정됐어요. ' || to_char(vote_deadline_of(new.day) at time zone 'Asia/Seoul', 'FMMM"월" FMDD"일"') || ' 밤 9시까지 시간을 골라주세요'
      else '모임이 확정됐어요' end);
  end if;
  if not old.vote_reminded and new.vote_reminded then
    perform system_message(new.id, '시간 투표가 내일 밤 9시에 마감돼요. 아직 안 골랐으면 위 투표에서 골라주세요');
  end if;
  if not old.finalized and new.finalized then
    perform system_message(new.id, '시간이 ' || coalesce(new.time_label, kslot(new.slot)) || '로 정해졌어요'
      || coalesce(' · 식당은 ' || v_place, case when new.tie_place_ids is not null then ' · 식당은 최종 하트로 정해요' else '' end));
  elsif new.place_id is not null and new.place_id is distinct from old.place_id then
    perform system_message(new.id, '식당이 ' || v_place || '(으)로 정해졌어요');
  end if;
  if old.tie_place_ids is null and new.tie_place_ids is not null then
    perform system_message(new.id, '식당 하트가 똑같이 나왔어요. 내일까지 최종 하트를 하나 골라주세요');
  end if;
  if old.slot <> 'B' and new.slot = 'B' then
    perform system_message(new.id, '저녁·점심 둘 다 되는 친구가 많아서 시간 후보가 6개로 늘었어요');
  end if;
  return new;
end $$;

drop trigger if exists rooms_chat_update on public.rooms;
create trigger rooms_chat_update after update on public.rooms
  for each row execute function public.chat_room_update();

create or replace function public.chat_member_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  select name into v_name from members where id = new.member_id;
  if new.status = 'joined' and (tg_op = 'INSERT' or old.status <> 'joined') then
    perform system_message(new.room_id, coalesce(v_name, '친구') || '님이 참석해요');
  elsif tg_op = 'UPDATE' and old.status = 'joined' and new.status <> 'joined' then
    perform system_message(new.room_id, '한 명이 참석을 취소했어요');
  end if;
  return new;
end $$;

drop trigger if exists room_members_chat on public.room_members;
create trigger room_members_chat after insert or update on public.room_members
  for each row execute function public.chat_member_update();

-- ─────────────────────────────────────────────
-- 정리: 모임 날짜 일주일 뒤 대화 삭제
-- ─────────────────────────────────────────────
create or replace function public.cleanup_rooms()
returns void language plpgsql security definer set search_path = public as $$
declare x record;
begin
  insert into dismissed_slots (group_id, day, slot, dismissed_at)
    select r.group_id, r.day, s, now() from rooms r,
      unnest(case when r.slot = 'B' then array['L', 'D'] else array[r.slot] end) s
    where r.kind = 'auto' and r.status = 'open' and r.reply_deadline < now()
    on conflict (group_id, day, slot) do update set dismissed_at = now();
  delete from rooms where kind = 'auto' and status = 'open' and reply_deadline < now();

  for x in select id from rooms where kind = 'manual' and status = 'open' and reply_deadline < now() loop
    perform manual_check_confirm(x.id, true);
  end loop;

  delete from messages m using rooms r where r.id = m.room_id and r.day < seoul_today() - 7;
  delete from room_reads rr using rooms r where r.id = rr.room_id and r.day < seoul_today() - 7;
  delete from dismissed_slots where day < seoul_today();
  delete from availability where day < seoul_today() - 1;
  perform recheck_all_rooms();
end $$;

revoke execute on function public.system_message(uuid, text), public.cleanup_rooms() from public, anon, authenticated;
revoke execute on function public.send_message(uuid, text, uuid), public.delete_message(bigint), public.mark_read(uuid, bigint),
  public.set_room_mute(uuid, boolean), public.room_unread(uuid), public.my_joined_member(uuid) from public, anon;
grant execute on function public.send_message(uuid, text, uuid), public.delete_message(bigint), public.mark_read(uuid, bigint),
  public.set_room_mute(uuid, boolean), public.room_unread(uuid), public.my_joined_member(uuid) to authenticated;
