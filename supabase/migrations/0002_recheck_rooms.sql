-- 0002: 이미 칠해둔 시간도 방 생성 조건을 다시 확인해요
-- 이전에는 "누가 칠하는 순간"에만 확인해서, 아래 경우에 방이 안 생겼어요.
--   1) 방장이 기준 인원을 낮췄을 때
--   2) 15일 넘게 남았을 때 칠해둔 날이 날짜가 지나 8~14일 창 안으로 들어왔을 때
-- Supabase SQL Editor에서 이 파일 내용을 붙여넣고 Run 하면 돼요.

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
  select count(*) into v_after from rooms where group_id = p_group;
  return v_after - v_before;
end $$;

-- 앱에서 부르는 버전: 그룹 멤버만
create or replace function public.recheck_rooms(p_group uuid)
returns int language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from members where group_id = p_group and user_id = auth.uid()) then
    raise exception 'not a member';
  end if;
  return recheck_rooms_internal(p_group);
end $$;

-- 기준 인원을 바꾸면 바로 다시 확인
create or replace function public.set_threshold(p_group uuid, p_threshold int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from groups where id = p_group and owner_id = auth.uid()) then
    raise exception 'only the owner can change this';
  end if;
  update groups set threshold = p_threshold where id = p_group;
  perform recheck_rooms_internal(p_group);
end $$;

-- 모든 그룹을 한 번에 확인 (정리 작업에서 사용)
create or replace function public.recheck_all_rooms()
returns void language plpgsql security definer set search_path = public as $$
declare g record;
begin
  for g in select id from groups loop
    perform recheck_rooms_internal(g.id);
  end loop;
end $$;

create or replace function public.cleanup_rooms()
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from rooms where status = 'open' and reply_deadline < now();
  delete from dismissed_slots where day < seoul_today();
  delete from availability where day < seoul_today() - 1;
  perform recheck_all_rooms();
end $$;

revoke execute on function public.recheck_rooms(uuid), public.recheck_rooms_internal(uuid), public.recheck_all_rooms(), public.cleanup_rooms() from public, anon;
grant execute on function public.recheck_rooms(uuid) to authenticated;
revoke execute on function public.recheck_rooms_internal(uuid), public.recheck_all_rooms(), public.cleanup_rooms() from authenticated;

-- 지금 있는 그룹들도 한 번 확인
select public.recheck_all_rooms();
