-- 0016: 날짜를 누르면 그날 칠한 친구 이름이 보여요 (같은 그룹 멤버끼리만)
create or replace function public.availability_names(p_group uuid, p_from date, p_to date)
returns table (day date, slot text, member_id uuid)
language sql stable security definer set search_path = public as $$
  select a.day, a.slot, a.member_id
  from availability a
  join members m on m.id = a.member_id
  where a.group_id = p_group
    and public.is_group_member(p_group)
    and a.day between p_from and p_to
    and m.user_id <> auth.uid()
$$;

revoke execute on function public.availability_names(uuid, date, date) from public, anon;
grant execute on function public.availability_names(uuid, date, date) to authenticated;
