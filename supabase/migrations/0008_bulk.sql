-- 0008: 빠르게 칠하기 · 전체 지우기 · 초대장 알림 묶기
-- Supabase SQL Editor에서 새 쿼리를 열고 이 파일 내용을 붙여넣은 뒤 Run 하면 돼요.
--
--  · 빠르게 칠하기: 내일부터 4주 안의 빈칸만 채워요. 아래 칸은 건너뛰어요
--      - 이미 칠한 칸
--      - 내가 패스했거나 빠졌던 방이 있는 칸 (한 번에 칠하다 실수로 다시 들어가지 않게)
--      - 누군가 없앤 시간대 (일괄 칠하기로 지운 방이 되살아나지 않게. 그 칸을 직접 누르면 다시 열려요)
--  · 전체 지우기: 오늘부터 앞으로 내가 칠한 칸만 지워요. 이미 생긴 방·초대장·참석은 그대로예요
--  · 같은 사람에게 2분 안에 초대장이 여러 개 생기면 알림 하나로 묶어요
--  · 내가 칠해서 방이 생긴 경우, 나에게는 초대장 알림을 보내지 않아요 (이미 앱을 보고 있으니까요)

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
    order by d;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.clear_my_paint(p_group uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_me uuid;
  v_n int;
begin
  select id into v_me from members where group_id = p_group and user_id = auth.uid();
  if v_me is null then raise exception 'not a member'; end if;
  delete from availability where member_id = v_me and day >= seoul_today();
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- 초대장 알림 묶기
create or replace function public.enqueue(p_member uuid, p_pref text, p_title text, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_title text;
  v_n int;
begin
  if not exists (
    select 1 from members m
    where m.id = p_member and coalesce((m.notify ->> p_pref)::boolean, true)
  ) then return; end if;

  if p_title = '새 초대장' then
    select id, title into v_id, v_title from notifications
      where member_id = p_member and sent_at is null and title like '새 초대장%'
        and created_at > now() - interval '2 minutes'
      order by id desc limit 1;
    if v_id is not null then
      v_n := coalesce(substring(v_title from '(\d+)개')::int, 1) + 1;
      update notifications set
        title = '새 초대장 ' || v_n || '개',
        body = '될 수도 있는 시간에 방이 ' || v_n || '개 생겼어요. 홈에서 참석할지 골라주세요'
        where id = v_id;
      return;
    end if;
  end if;

  insert into notifications (member_id, kind, title, body) values (p_member, p_pref, p_title, p_body);
end $$;

create or replace function public.notify_invite()
returns trigger language plpgsql security definer set search_path = public as $$
declare r rooms; v_from text;
begin
  if new.status <> 'invited' then return new; end if;
  if exists (select 1 from members where id = new.member_id and user_id = auth.uid()) then return new; end if;
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

revoke execute on function public.bulk_paint(uuid, text), public.clear_my_paint(uuid) from public, anon;
grant execute on function public.bulk_paint(uuid, text), public.clear_my_paint(uuid) to authenticated;
revoke execute on function public.enqueue(uuid, text, text, text) from public, anon, authenticated;
