-- 0014: 맛집 종류에 양식·술집 추가
-- Supabase SQL Editor에서 새 쿼리를 열고 이 파일 내용을 붙여넣은 뒤 Run 하면 돼요.
--  · 종류: 한식 / 중식 / 일식 / 양식 / 분식 / 술집 / 기타
--  · 지금 '기타'에 있는 맛집 중 이름으로 알 수 있는 곳은 양식·술집으로 옮겨요

alter table public.places drop constraint if exists places_category_check;
alter table public.places add constraint places_category_check
  check (category in ('한식', '중식', '일식', '양식', '분식', '술집', '기타'));

update public.places set category = case
  when name ~ '(파스타|피자|버거|스테이크|브런치|비스트로|트라토리아|오스테리아|리조또|양식)' then '양식'
  when name ~ '(포차|이자카야|와인|맥주|펍|바$| 바 |호프|칵테일|하이볼|막걸리|술집)' then '술집'
  else category end
where category = '기타';

create or replace function public.add_place(p_group uuid, p_name text, p_category text, p_area text, p_url text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_me uuid; v_id uuid;
begin
  select id into v_me from members where group_id = p_group and user_id = auth.uid();
  if v_me is null then raise exception 'not a member'; end if;
  if p_category is null or p_category not in ('한식', '중식', '일식', '양식', '분식', '술집', '기타') then
    raise exception 'pick a category';
  end if;
  insert into places (group_id, name, category, area, url, added_by)
    values (p_group, trim(p_name), p_category, nullif(trim(p_area), ''), nullif(trim(p_url), ''), v_me)
    returning id into v_id;
  insert into place_hearts (place_id, member_id) values (v_id, v_me);
  return v_id;
end $$;
