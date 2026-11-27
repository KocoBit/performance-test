-- 출제 순서: 학습 순서대로 묶고(학습 1 → 학습 2 …), 같은 학습 안의 순서와 보기 순서는 학생마다 섞기
create or replace function private.draw_items(p_round int) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_total int; v_units int[]; n int; v_base int; v_rem int; v_extra int[];
  u int; k int; cnt int; q record;
  v_picked bigint[] := '{}'; v_groups text[] := '{}'; v_items jsonb;
begin
  select question_count into v_total from public.rounds where round_no = p_round;
  select array_agg(un.unit_no order by un.unit_no) into v_units
    from public.units un
   where un.round_no = p_round
     and exists (select 1 from public.questions qq where qq.round_no = p_round and qq.unit_no = un.unit_no);
  n := coalesce(array_length(v_units, 1), 0);
  if n = 0 then raise exception 'NO_QUESTIONS'; end if;
  v_base := v_total / n;
  v_rem := v_total % n;
  select coalesce(array_agg(x), '{}') into v_extra
    from (select x from unnest(v_units) x order by random() limit v_rem) s;

  foreach u in array v_units loop
    k := v_base + case when u = any (v_extra) then 1 else 0 end;
    cnt := 0;
    for q in select id, exclusion_group from public.questions
              where round_no = p_round and unit_no = u order by random() loop
      exit when cnt >= k;
      if q.exclusion_group is not null and q.exclusion_group = any (v_groups) then continue; end if;
      v_picked := v_picked || q.id;
      cnt := cnt + 1;
      if q.exclusion_group is not null then v_groups := v_groups || q.exclusion_group; end if;
    end loop;
    if cnt < k then raise exception 'NOT_ENOUGH_QUESTIONS'; end if;
  end loop;

  select jsonb_agg(jsonb_build_object(
           'q', qq.id,
           'perm', (select jsonb_agg(i order by random()) from generate_series(0, jsonb_array_length(qq.options) - 1) i))
         order by qq.unit_no, random())
    into v_items
    from public.questions qq where qq.id = any (v_picked);
  return v_items;
end $$;

-- 학생 화면에 학습 번호·이름도 함께 보낸다(정답은 보내지 않음)
create or replace function private.items_for_student(a public.attempts) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'stem', q.stem,
           'unit_no', q.unit_no,
           'unit_title', un.title,
           'options', (select jsonb_agg(q.options -> (p.v)::int order by p.ord)
                         from jsonb_array_elements_text(e.it -> 'perm') with ordinality p(v, ord)),
           'mine', (select (p.ord - 1)::int
                        from jsonb_array_elements_text(e.it -> 'perm') with ordinality p(v, ord)
                       where p.v::int = (a.answers ->> (e.ord - 1)::text)::int)
         ) order by e.ord), '[]')
    from jsonb_array_elements(a.items) with ordinality e(it, ord)
    join public.questions q on q.id = (e.it ->> 'q')::bigint
    left join public.units un on un.round_no = q.round_no and un.unit_no = q.unit_no;
$$;
