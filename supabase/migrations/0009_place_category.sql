-- 0009: 맛집 종류를 5개 중 하나로 (필수)
-- Supabase SQL Editor에서 새 쿼리를 열고 이 파일 내용을 붙여넣은 뒤 Run 하면 돼요.
--  · 종류: 한식 / 중식 / 일식 / 분식 / 기타
--  · 이미 담긴 맛집은 적어둔 종류(없으면 이름)를 보고 자동으로 나눠요. 애매하면 기타

alter table public.places drop constraint if exists places_category_check;

update public.places set category = case
  when (coalesce(category, '') || ' ' || name) ~ '(중식|중국|반점|마라|딤섬|짜장|짬뽕|훠궈|양장피|탕수육|양꼬치)' then '중식'
  when (coalesce(category, '') || ' ' || name) ~ '(일식|스시|초밥|라멘|우동|소바|오마카세|돈카츠|돈까스|규동|덮밥|사시미|이자카야)' then '일식'
  when (coalesce(category, '') || ' ' || name) ~ '(분식|떡볶이|김밥|순대|튀김|라볶이)' then '분식'
  when (coalesce(category, '') || ' ' || name) ~ '(한식|국밥|찌개|백반|냉면|칼국수|국수|보리밥|한정식|곰탕|해장|고기|삼겹|갈비|곱창|막창|구이|한우|족발|보쌈|닭갈비|곱)' then '한식'
  else '기타'
end
where category is null or category not in ('한식', '중식', '일식', '분식', '기타');

alter table public.places alter column category set not null;
alter table public.places add constraint places_category_check
  check (category in ('한식', '중식', '일식', '분식', '기타'));

create or replace function public.add_place(p_group uuid, p_name text, p_category text, p_area text, p_url text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_me uuid; v_id uuid;
begin
  select id into v_me from members where group_id = p_group and user_id = auth.uid();
  if v_me is null then raise exception 'not a member'; end if;
  if p_category is null or p_category not in ('한식', '중식', '일식', '분식', '기타') then
    raise exception 'pick a category';
  end if;
  insert into places (group_id, name, category, area, url, added_by)
    values (p_group, trim(p_name), p_category, nullif(trim(p_area), ''), nullif(trim(p_url), ''), v_me)
    returning id into v_id;
  insert into place_hearts (place_id, member_id) values (v_id, v_me);
  return v_id;
end $$;
