-- 0011: 여러 모임 (한 사람이 여러 모임에 들어갈 수 있어요)
-- Supabase SQL Editor에서 새 쿼리를 열고 이 파일 내용을 붙여넣은 뒤 Run 하면 돼요.
--
--  · 알림 기기를 "사람" 기준으로 바꿔요. 어느 모임의 알림이든 같은 기기로 오고,
--    한 모임에서 나가도 다른 모임 알림은 계속 와요
--  · 모임이 두 개 이상인 사람에게만 알림 제목 앞에 모임 이름이 붙어요 (받는 본인 폰에만 보여요)
--  · 알림을 누르면 그 모임 화면으로 열려요
--  · 겹침 확인: 다른 모임에서 내가 참석하기로 확정된 시간을 본인에게만 알려줘요
--  · 빠르게 칠하기는 다른 모임에서 확정된 시간을 건너뛰어요
--  · 모임 이름은 비워둘 수 없어요

-- ─────────────────────────────────────────────
-- 알림 기기: 사람 기준
-- ─────────────────────────────────────────────
alter table public.push_subscriptions add column if not exists user_id uuid references auth.users(id) on delete cascade;
update public.push_subscriptions s set user_id = m.user_id
  from public.members m where m.id = s.member_id and s.user_id is null;
delete from public.push_subscriptions where user_id is null;
alter table public.push_subscriptions alter column user_id set not null;

-- 모임에서 나가도 기기가 지워지지 않게
alter table public.push_subscriptions drop constraint if exists push_subscriptions_member_id_fkey;
alter table public.push_subscriptions alter column member_id drop not null;
alter table public.push_subscriptions
  add constraint push_subscriptions_member_id_fkey foreign key (member_id) references public.members(id) on delete set null;
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

drop policy if exists push_subs_read_own on public.push_subscriptions;
create policy push_subs_read_own on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from members where user_id = auth.uid()) then raise exception 'not a member'; end if;
  if p_endpoint !~ '^https://' then raise exception 'bad endpoint'; end if;
  insert into push_subscriptions (endpoint, user_id, member_id, p256dh, auth)
    values (p_endpoint, auth.uid(), null, p_p256dh, p_auth)
    on conflict (endpoint) do update set user_id = excluded.user_id, member_id = null,
      p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;

-- 보낼 알림 꺼내기: 모임이 둘 이상이면 제목 앞에 모임 이름, 누르면 그 모임으로
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
      '/?g=' || m.group_id::text
    from (select * from notifications where sent_at is null order by notifications.id limit p_limit) n
    join members m on m.id = n.member_id
    join groups g on g.id = m.group_id
    join push_subscriptions s on s.user_id = m.user_id;
end $$;

-- ─────────────────────────────────────────────
-- 겹침 확인 (본인에게만)
-- ─────────────────────────────────────────────
-- p_group 말고 다른 모임에서, 내가 참석하기로 한 확정 모임
create or replace function public.my_busy(p_group uuid)
returns table (day date, slot text, group_name text, time_label text)
language sql stable security definer set search_path = public as $$
  select r.day, r.slot, g.name, r.time_label
  from rooms r
  join groups g on g.id = r.group_id
  join room_members rm on rm.room_id = r.id and rm.status = 'joined'
  join members m on m.id = rm.member_id and m.user_id = auth.uid()
  where r.group_id <> p_group and r.status = 'confirmed' and r.day >= seoul_today()
  order by r.day, r.slot
$$;

-- 빠르게 칠하기: 다른 모임에서 확정된 내 시간은 건너뛰기
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
        where r.group_id = p_group and r.day = d::date and r.slot = v_slot and r.kind = 'auto' and rm.member_id = v_me
      )
      and not exists (select 1 from my_busy(p_group) b where b.day = d::date and b.slot = v_slot)
    order by d;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ─────────────────────────────────────────────
-- 모임 이름은 꼭 있어야 해요
-- ─────────────────────────────────────────────
create or replace function public.create_group(p_group_name text, p_threshold int, p_my_name text, p_color text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_code text;
  v_gid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if coalesce(trim(p_group_name), '') = '' then raise exception 'name the group'; end if;
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

revoke execute on function public.my_busy(uuid) from public, anon;
grant execute on function public.my_busy(uuid) to authenticated;
