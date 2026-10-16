-- 0006: 확정된 모임에서 한 명이 빠져도, 남은 사람이 충분하면 모임은 그대로
-- Supabase SQL Editor에서 새 쿼리를 열고 이 파일 내용을 붙여넣은 뒤 Run 하면 돼요.
--
--  · 자동 방: 남은 참석자가 기준 인원 이상이면 유지, 아니면 방이 없어져요
--  · 직접 방: 남은 참석자가 2명 이상이면 유지, 아니면 방이 없어져요
--  · 빠진 사람은 그 칸 칠이 지워지고, 남은 참석자에게 "한 명이 빠졌어요" 알림이 가요 (이름은 안 보여줘요)
--  · 빠진 사람이 마음이 바뀌면 다시 참석할 수 있어요
--  · 확정된 자동 방은 X로 없앨 수 없어요 (한 사람이 모두의 약속을 지우지 않게). 직접 방은 만든 사람만 없앨 수 있어요

create or replace function public.respond_room(p_room uuid, p_status text)
returns text language plpgsql security definer set search_path = public as $$
declare
  r rooms;
  v_me uuid;
  v_old text;
  v_threshold int;
  v_joined int;
  v_total int;
  v_need int;
begin
  if p_status not in ('joined', 'passed', 'invited') then raise exception 'bad status'; end if;
  select * into r from rooms where id = p_room for update;
  if r.id is null then raise exception 'room not found'; end if;

  select rm.member_id, rm.status into v_me, v_old
    from room_members rm join members m on m.id = rm.member_id
    where rm.room_id = p_room and m.user_id = auth.uid();
  if v_me is null then raise exception 'not invited'; end if;

  select threshold into v_threshold from groups where id = r.group_id;
  v_need := case when r.kind = 'auto' then v_threshold else 2 end;

  -- 확정된 모임에서 빠지기
  if r.status = 'confirmed' and v_old = 'joined' and p_status <> 'joined' then
    update room_members set status = 'passed', updated_at = now()
      where room_id = p_room and member_id = v_me;
    if r.kind = 'auto' then perform forget_paint(v_me, r.day, r.slot); end if;
    select count(*) into v_joined from room_members where room_id = p_room and status = 'joined';
    if v_joined < v_need then
      perform delete_room_internal(p_room);
      return 'deleted';
    end if;
    perform enqueue_joined(p_room, 'invite', '한 명이 빠졌어요',
      coalesce(r.title || ' · ', '') || kdate(r.day) || ' ' || kslot(r.slot) || ' · 지금 ' || v_joined || '명, 모임은 그대로예요');
    return 'left';
  end if;

  if r.status = 'open' and r.reply_deadline < now() then raise exception 'room expired'; end if;

  update room_members set status = p_status, updated_at = now()
    where room_id = p_room and member_id = v_me;

  if p_status = 'passed' and r.kind = 'auto' then perform forget_paint(v_me, r.day, r.slot); end if;

  if r.status = 'open' then
    select count(*) filter (where status = 'joined'), count(*)
      into v_joined, v_total from room_members where room_id = p_room;
    if r.kind = 'auto' then
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
  if r.status = 'confirmed' and (r.kind = 'auto' or r.created_by is distinct from v_me) then
    raise exception 'leave instead';
  end if;
  if r.kind = 'auto' then perform forget_paint(v_me, r.day, r.slot); end if;
  perform delete_room_internal(p_room);
end $$;
