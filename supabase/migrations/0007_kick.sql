-- 0007: 방장이 멤버 내보내기 + 그룹 나가기 정리
-- Supabase SQL Editor에서 새 쿼리를 열고 이 파일 내용을 붙여넣은 뒤 Run 하면 돼요.
--
--  · 방장은 설정 → 멤버에서 다른 멤버를 내보낼 수 있어요
--  · 내보내거나 나간 사람이 참석하던 확정 모임은 0006 규칙대로: 남은 사람이 충분하면 유지, 아니면 없어져요
--  · 직접 방에서 그 사람만 응답을 안 하고 있었다면, 남은 사람이 모두 참석한 상태가 되어 확정돼요
--  · 방장이 그룹을 나가면 가장 먼저 들어온 멤버가 방장이 돼요

create or replace function public.remove_member_internal(p_member uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m members;
  r record;
  v_need int;
  v_joined int;
  v_total int;
begin
  select * into m from members where id = p_member;
  if m.id is null then return; end if;

  for r in
    select ro.*, rm.status as my_status from rooms ro join room_members rm on rm.room_id = ro.id
    where rm.member_id = p_member
  loop
    delete from room_members where room_id = r.id and member_id = p_member;
    select count(*) filter (where status = 'joined'), count(*) into v_joined, v_total
      from room_members where room_id = r.id;
    v_need := case when r.kind = 'auto' then (select threshold from groups where id = r.group_id) else 2 end;

    if r.status = 'confirmed' and r.my_status = 'joined' then
      if v_joined < v_need then
        perform delete_room_internal(r.id);
      else
        perform enqueue_joined(r.id, 'invite', '한 명이 빠졌어요',
          coalesce(r.title || ' · ', '') || kdate(r.day) || ' ' || kslot(r.slot) || ' · 지금 ' || v_joined || '명, 모임은 그대로예요');
      end if;
    elsif r.status = 'open' and r.kind = 'manual' then
      if v_total < 2 then
        delete from rooms where id = r.id;
      elsif v_joined = v_total then
        update rooms set status = 'confirmed' where id = r.id;
      end if;
    end if;
  end loop;

  delete from members where id = p_member;

  -- 방장이 나갔으면 가장 먼저 들어온 멤버에게 넘겨요
  if exists (select 1 from groups where id = m.group_id and owner_id = m.user_id) then
    update groups set owner_id = (
      select user_id from members where group_id = m.group_id order by created_at limit 1
    ) where id = m.group_id and exists (select 1 from members where group_id = m.group_id);
  end if;
end $$;

create or replace function public.leave_group(p_group uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid;
begin
  select id into v_me from members where group_id = p_group and user_id = auth.uid();
  if v_me is null then return; end if;
  perform remove_member_internal(v_me);
end $$;

create or replace function public.kick_member(p_member uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m members;
begin
  select * into m from members where id = p_member;
  if m.id is null then raise exception 'not found'; end if;
  if not exists (select 1 from groups where id = m.group_id and owner_id = auth.uid()) then
    raise exception 'only the owner can change this';
  end if;
  if m.user_id = auth.uid() then raise exception 'cannot kick yourself'; end if;
  perform remove_member_internal(p_member);
end $$;

revoke execute on function public.remove_member_internal(uuid) from public, anon, authenticated;
revoke execute on function public.kick_member(uuid) from public, anon;
grant execute on function public.kick_member(uuid), public.leave_group(uuid) to authenticated;
