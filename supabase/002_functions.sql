-- ============ 내부 함수(외부에서 호출 불가: private 스키마) ============

create function private.err(p_code text, p_extra jsonb default '{}') returns jsonb
language sql immutable as $$ select jsonb_build_object('ok', false, 'error', p_code) || p_extra $$;

create function private.sha(p text) returns text
language sql immutable as $$ select encode(extensions.digest(p, 'sha256'), 'hex') $$;

create function private.client_ip() returns text
language sql stable as $$
  select trim(split_part(coalesce(
    nullif(current_setting('request.headers', true), '')::json ->> 'cf-connecting-ip',
    nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for',
    ''), ',', 1));
$$;

create function private.rand_digits(n int) returns text
language sql volatile as $$
  select lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % (10 ^ n)::bigint)::text, n, '0');
$$;

-- 출제: 단원별 균등(나머지는 무작위 단원에 1개씩), 함께 출제 금지 묶음은 1개만, 순서·보기 섞기
create function private.draw_items(p_round int) returns jsonb
language plpgsql volatile as $$
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
         order by random())
    into v_items
    from public.questions qq where qq.id = any (v_picked);
  return v_items;
end $$;

-- 채점·제출 확정
create function private.finalize(p_id bigint, p_reason text) returns void
language plpgsql volatile as $$
declare a public.attempts; r public.rounds; c int;
begin
  select * into a from public.attempts where id = p_id for update;
  if not found or a.status = 'submitted' then return; end if;
  select * into r from public.rounds where round_no = a.round_no;
  select count(*) into c
    from jsonb_array_elements(a.items) with ordinality e(it, ord)
    join public.questions q on q.id = (e.it ->> 'q')::bigint
   where (a.answers ->> (e.ord - 1)::text)::int = q.answer;
  update public.attempts
     set status = 'submitted',
         submitted_at = case when a.deadline is not null then least(now(), a.deadline) else now() end,
         submit_reason = p_reason,
         correct_count = c,
         score = c * r.points_per_q + r.base_score
   where id = p_id;
  insert into public.events (attempt_id, type, detail) values (p_id, 'submit', jsonb_build_object('reason', p_reason));
end $$;

create function private.finalize_if_expired(p_id bigint) returns void
language plpgsql volatile as $$
begin
  if exists (select 1 from public.attempts
              where id = p_id and status = 'in_progress' and now() > deadline + interval '5 seconds') then
    perform private.finalize(p_id, 'timeout');
  end if;
end $$;

-- 응시 토큰으로 응시 찾기
create function private.attempt_by_token(p_token text) returns public.attempts
language sql stable as $$
  select * from public.attempts where token_hash = private.sha(coalesce(p_token, '')) limit 1;
$$;

-- 학생에게 보여 줄 문항(정답 없음)
create function private.items_for_student(a public.attempts) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'stem', q.stem,
           'options', (select jsonb_agg(q.options -> (p.v)::int order by p.ord)
                         from jsonb_array_elements_text(e.it -> 'perm') with ordinality p(v, ord)),
           'mine', (select (p.ord - 1)::int
                        from jsonb_array_elements_text(e.it -> 'perm') with ordinality p(v, ord)
                       where p.v::int = (a.answers ->> (e.ord - 1)::text)::int)
         ) order by e.ord), '[]')
    from jsonb_array_elements(a.items) with ordinality e(it, ord)
    join public.questions q on q.id = (e.it ->> 'q')::bigint;
$$;

create function private.remaining(a public.attempts) returns int
language sql stable as $$
  select case when a.deadline is null then null
              else greatest(0, ceil(extract(epoch from a.deadline - now())))::int end;
$$;

create function private.require_admin() returns void
language plpgsql stable as $$
begin
  if not public.is_admin() then raise exception 'NOT_ADMIN'; end if;
end $$;

-- ============ 학생용 함수 ============

-- 입장: 학번·코드·입장 암호 확인, 처음이면 문항을 뽑아 저장(새로고침해도 다시 뽑지 않음)
create function public.student_enter(p_round int, p_student_no text, p_code text, p_pin text,
                                     p_device text, p_lockdown boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  st public.settings; s public.students; cs public.class_sessions; a public.attempts; r public.rounds;
  v_ip text; v_tok text;
begin
  select * into st from public.settings where id = 1;
  v_ip := private.client_ip();
  if coalesce(array_length(st.allowed_ip_prefixes, 1), 0) > 0
     and not exists (select 1 from unnest(st.allowed_ip_prefixes) p where v_ip like p || '%') then
    return private.err('NETWORK');
  end if;
  if st.require_lockdown and not coalesce(p_lockdown, false) then
    return private.err('LOCKDOWN_REQUIRED');
  end if;

  select * into s from public.students where student_no = trim(p_student_no) for update;
  if not found then return private.err('BAD_CREDENTIALS'); end if;
  if s.locked_until is not null and s.locked_until > now() then
    return private.err('LOCKED', jsonb_build_object('seconds', ceil(extract(epoch from s.locked_until - now()))));
  end if;
  if s.code <> trim(coalesce(p_code, '')) then
    update public.students
       set fail_count = case when fail_count + 1 >= 5 then 0 else fail_count + 1 end,
           locked_until = case when fail_count + 1 >= 5 then now() + interval '10 minutes' else locked_until end
     where student_no = s.student_no;
    return private.err('BAD_CREDENTIALS');
  end if;
  if s.excluded then return private.err('EXCLUDED'); end if;

  select * into r from public.rounds where round_no = p_round;
  if not found then return private.err('NO_ROUND'); end if;
  select * into cs from public.class_sessions where round_no = p_round and class_no = s.class_no;
  if not found or not cs.is_open then return private.err('NOT_OPEN'); end if;
  if cs.pin <> trim(coalesce(p_pin, '')) then
    update public.students
       set fail_count = case when fail_count + 1 >= 5 then 0 else fail_count + 1 end,
           locked_until = case when fail_count + 1 >= 5 then now() + interval '10 minutes' else locked_until end
     where student_no = s.student_no;
    return private.err('BAD_PIN');
  end if;
  update public.students set fail_count = 0, locked_until = null where student_no = s.student_no;

  select * into a from public.attempts where round_no = p_round and student_no = s.student_no for update;
  if found then
    perform private.finalize_if_expired(a.id);
    select * into a from public.attempts where id = a.id;
    if a.status = 'submitted' then return private.err('ALREADY_SUBMITTED'); end if;
    if a.device_id is not null and a.device_id <> coalesce(p_device, '') and not a.allow_device_change then
      insert into public.events (attempt_id, type, detail)
      values (a.id, 'device_conflict', jsonb_build_object('ip', v_ip));
      return private.err('OTHER_DEVICE');
    end if;
  else
    begin
      insert into public.attempts (round_no, student_no, items)
      values (p_round, s.student_no, private.draw_items(p_round)) returning * into a;
    exception when raise_exception then
      return private.err('NO_QUESTIONS');
    end;
  end if;

  v_tok := encode(gen_random_bytes(24), 'hex');
  update public.attempts
     set token_hash = private.sha(v_tok), device_id = coalesce(p_device, ''), allow_device_change = false,
         lockdown = lockdown or coalesce(p_lockdown, false), last_seen = now()
   where id = a.id;
  insert into public.events (attempt_id, type, detail)
  values (a.id, 'enter', jsonb_build_object('lockdown', coalesce(p_lockdown, false), 'ip', v_ip));

  return jsonb_build_object('ok', true, 'token', v_tok, 'status', a.status,
    'round_title', r.title, 'duration_min', r.duration_min, 'question_count', jsonb_array_length(a.items),
    'student_no', s.student_no);
end $$;

-- 시작(처음 누를 때부터 시간 계산) 또는 이어서 풀기
create function public.student_start(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a public.attempts; r public.rounds;
begin
  a := private.attempt_by_token(p_token);
  if a.id is null then return private.err('SESSION'); end if;
  perform private.finalize_if_expired(a.id);
  select * into a from public.attempts where id = a.id;
  if a.status = 'submitted' then return private.err('ALREADY_SUBMITTED'); end if;
  if not exists (select 1 from public.class_sessions cs join public.students s on s.class_no = cs.class_no
                  where cs.round_no = a.round_no and s.student_no = a.student_no and cs.is_open) then
    return private.err('NOT_OPEN');
  end if;
  if a.started_at is null then
    select * into r from public.rounds where round_no = a.round_no;
    update public.attempts
       set started_at = now(), status = 'in_progress',
           deadline = now() + make_interval(mins => r.duration_min) + make_interval(secs => extra_seconds)
     where id = a.id returning * into a;
    insert into public.events (attempt_id, type) values (a.id, 'start');
  end if;
  update public.attempts set last_seen = now() where id = a.id;
  return jsonb_build_object('ok', true, 'items', private.items_for_student(a),
                            'remaining', private.remaining(a), 'student_no', a.student_no);
end $$;

-- 답 저장(고를 때마다)
create function public.student_answer(p_token text, p_index int, p_choice int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a public.attempts; v_orig int; v_n int;
begin
  a := private.attempt_by_token(p_token);
  if a.id is null then return private.err('SESSION'); end if;
  perform private.finalize_if_expired(a.id);
  select * into a from public.attempts where id = a.id;
  if a.status <> 'in_progress' then return private.err('ALREADY_SUBMITTED'); end if;
  v_n := jsonb_array_length(a.items);
  if p_index is null or p_index < 0 or p_index >= v_n then return private.err('BAD_INPUT'); end if;
  if p_choice is null then
    update public.attempts set answers = answers - p_index::text, last_seen = now() where id = a.id;
  else
    v_orig := (a.items -> p_index -> 'perm' ->> p_choice)::int;
    if v_orig is null then return private.err('BAD_INPUT'); end if;
    update public.attempts set answers = jsonb_set(answers, array[p_index::text], to_jsonb(v_orig)), last_seen = now()
     where id = a.id;
  end if;
  insert into public.events (attempt_id, type, item_index) values (a.id, 'answer', p_index);
  return jsonb_build_object('ok', true, 'remaining', private.remaining(a));
end $$;

-- 사건 기록(이탈·복귀·복사 시도 등) + 상태 확인(교사가 닫았는지, 남은 시간)
create function public.student_log(p_token text, p_events jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a public.attempts;
begin
  a := private.attempt_by_token(p_token);
  if a.id is null then return private.err('SESSION'); end if;
  perform private.finalize_if_expired(a.id);
  select * into a from public.attempts where id = a.id;
  if jsonb_typeof(p_events) = 'array' then
    insert into public.events (attempt_id, type, item_index, detail)
    select a.id, e ->> 'type', (e ->> 'item')::int, e -> 'detail'
      from (select e from jsonb_array_elements(p_events) e limit 50) x
     where e ->> 'type' in ('leave', 'return', 'fullscreen_exit', 'fullscreen_enter', 'copy', 'paste',
                            'contextmenu', 'print', 'key_block', 'view', 'lockdown', 'resize');
  end if;
  update public.attempts set last_seen = now() where id = a.id;
  return jsonb_build_object('ok', true, 'status', a.status, 'remaining', private.remaining(a));
end $$;

-- 제출
create function public.student_submit(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a public.attempts;
begin
  a := private.attempt_by_token(p_token);
  if a.id is null then return private.err('SESSION'); end if;
  if a.status = 'in_progress' then perform private.finalize(a.id, 'manual'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- 결과 확인: 회차가 닫히면 점수, 오답 공개 뒤에는 20문항·내 답·정답
create function public.student_result(p_student_no text, p_code text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s public.students; v_out jsonb := '[]'; rr record;
begin
  select * into s from public.students where student_no = trim(p_student_no) for update;
  if not found then return private.err('BAD_CREDENTIALS'); end if;
  if s.locked_until is not null and s.locked_until > now() then
    return private.err('LOCKED', jsonb_build_object('seconds', ceil(extract(epoch from s.locked_until - now()))));
  end if;
  if s.code <> trim(coalesce(p_code, '')) then
    update public.students
       set fail_count = case when fail_count + 1 >= 5 then 0 else fail_count + 1 end,
           locked_until = case when fail_count + 1 >= 5 then now() + interval '10 minutes' else locked_until end
     where student_no = s.student_no;
    return private.err('BAD_CREDENTIALS');
  end if;
  update public.students set fail_count = 0, locked_until = null where student_no = s.student_no;

  for rr in
    select r.*, a.id as aid, a.status as astatus, a.correct_count, a.score, a.items, a.answers,
           -- 반을 다시 연 동안(3차시)에 제출한 학생은 그 차시를 닫을 때 공개
           (coalesce(cs.score_released, false)
             and (not cs.is_open or a.submitted_at < cs.opened_at)) as released
      from public.rounds r
      left join public.attempts a on a.round_no = r.round_no and a.student_no = s.student_no
      left join public.class_sessions cs on cs.round_no = r.round_no and cs.class_no = s.class_no
     order by r.round_no
  loop
    v_out := v_out || jsonb_build_object(
      'round_no', rr.round_no, 'title', rr.title,
      'state', case when rr.aid is null then 'none'
                    when rr.astatus <> 'submitted' then 'in_progress'
                    when not rr.released then 'waiting'
                    else 'released' end,
      'correct', case when rr.astatus = 'submitted' and rr.released then rr.correct_count end,
      'total', case when rr.aid is not null then jsonb_array_length(rr.items) end,
      'score', case when rr.astatus = 'submitted' and rr.released then rr.score end,
      'review', case when rr.astatus = 'submitted' and rr.review_released then (
          select jsonb_agg(jsonb_build_object(
                   'no', e.ord, 'stem', q.stem, 'options', q.options, 'answer', q.answer,
                   'mine', (rr.answers ->> (e.ord - 1)::text)::int,
                   'correct', (rr.answers ->> (e.ord - 1)::text)::int = q.answer
                 ) order by e.ord)
            from jsonb_array_elements(rr.items) with ordinality e(it, ord)
            join public.questions q on q.id = (e.it ->> 'q')::bigint) end);
  end loop;
  return jsonb_build_object('ok', true, 'student_no', s.student_no, 'rounds', v_out);
end $$;

-- ============ 교사용 함수 ============

-- 반 회차 열기(새 입장 암호)
create function public.admin_open_session(p_round int, p_class int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_pin text;
begin
  perform private.require_admin();
  v_pin := private.rand_digits(4);
  insert into public.class_sessions (round_no, class_no, is_open, pin, opened_at, closed_at)
  values (p_round, p_class, true, v_pin, now(), null)
  on conflict (round_no, class_no) do update
     set is_open = true, pin = excluded.pin, opened_at = now(), closed_at = null;
  insert into public.audit_log (actor, action, detail)
  values (auth.uid(), 'open_session', jsonb_build_object('round', p_round, 'class', p_class));
  return jsonb_build_object('ok', true, 'pin', v_pin);
end $$;

-- 반 회차 닫기: 푸는 중인 답안 자동 제출, 시작 안 한 입장은 미응시로 되돌림, 그 반 점수 공개
create function public.admin_close_session(p_round int, p_class int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a record; n int := 0;
begin
  perform private.require_admin();
  for a in select at.id, at.status from public.attempts at join public.students s on s.student_no = at.student_no
            where at.round_no = p_round and s.class_no = p_class and at.status <> 'submitted' loop
    if a.status = 'in_progress' then
      perform private.finalize(a.id, 'closed'); n := n + 1;
    else
      delete from public.attempts where id = a.id;
    end if;
  end loop;
  update public.class_sessions set is_open = false, closed_at = now(), score_released = true, pin = null
   where round_no = p_round and class_no = p_class;
  insert into public.audit_log (actor, action, detail)
  values (auth.uid(), 'close_session', jsonb_build_object('round', p_round, 'class', p_class, 'auto_submitted', n));
  return jsonb_build_object('ok', true, 'auto_submitted', n);
end $$;

-- 실시간 감독: 반 학생별 상태
create function public.admin_monitor(p_round int, p_class int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v jsonb; a record;
begin
  perform private.require_admin();
  for a in select at.id from public.attempts at join public.students s on s.student_no = at.student_no
            where at.round_no = p_round and s.class_no = p_class and at.status = 'in_progress' loop
    perform private.finalize_if_expired(a.id);
  end loop;
  select coalesce(jsonb_agg(row order by row ->> 'student_no'), '[]') into v from (
    select jsonb_build_object(
      'student_no', s.student_no, 'excluded', s.excluded,
      'locked', s.locked_until is not null and s.locked_until > now(),
      'status', coalesce(at.status, 'none'),
      'attempt_id', at.id,
      'remaining', private.remaining(at),
      'answered', case when at.id is not null then (select count(*) from jsonb_object_keys(at.answers)) end,
      'total', case when at.id is not null then jsonb_array_length(at.items) end,
      'lockdown', coalesce(at.lockdown, false),
      'leaves', (select count(*) from public.events e where e.attempt_id = at.id and e.type in ('leave', 'fullscreen_exit')),
      'blocked', (select count(*) from public.events e where e.attempt_id = at.id and e.type in ('copy', 'paste', 'contextmenu', 'print', 'key_block')),
      'device_conflicts', (select count(*) from public.events e where e.attempt_id = at.id and e.type = 'device_conflict'),
      'away', coalesce((select e.type in ('leave', 'fullscreen_exit') from public.events e
                         where e.attempt_id = at.id and e.type in ('leave', 'return', 'fullscreen_exit', 'fullscreen_enter')
                         order by e.at desc, e.id desc limit 1), false),
      'online', at.last_seen is not null and at.last_seen > now() - interval '25 seconds',
      'extra_seconds', coalesce(at.extra_seconds, 0),
      'allow_device_change', coalesce(at.allow_device_change, false),
      'correct', at.correct_count, 'score', at.score, 'submit_reason', at.submit_reason
    ) as row
    from public.students s
    left join public.attempts at on at.student_no = s.student_no and at.round_no = p_round
    where s.class_no = p_class
  ) x;
  return jsonb_build_object('ok', true, 'students', v,
    'session', (select to_jsonb(cs) from public.class_sessions cs where cs.round_no = p_round and cs.class_no = p_class),
    'server_now', now());
end $$;

-- 결과: 회차 전체 학생
create function public.admin_results(p_round int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v jsonb;
begin
  perform private.require_admin();
  for v in select to_jsonb(at.id) from public.attempts at where at.round_no = p_round and at.status = 'in_progress' loop
    perform private.finalize_if_expired((v #>> '{}')::bigint);
  end loop;
  select coalesce(jsonb_agg(row order by row ->> 'student_no'), '[]') into v from (
    select jsonb_build_object(
      'student_no', s.student_no, 'class_no', s.class_no, 'excluded', s.excluded,
      'status', coalesce(at.status, 'none'),
      'correct', at.correct_count, 'total', case when at.id is not null then jsonb_array_length(at.items) end,
      'score', at.score, 'started_at', at.started_at, 'submitted_at', at.submitted_at, 'submit_reason', at.submit_reason,
      'lockdown', coalesce(at.lockdown, false),
      'leaves', (select count(*) from public.events e where e.attempt_id = at.id and e.type in ('leave', 'fullscreen_exit')),
      'away_seconds', (select coalesce(sum((e.detail ->> 'seconds')::numeric), 0)::int from public.events e
                        where e.attempt_id = at.id and e.type = 'return'),
      'blocked', (select count(*) from public.events e where e.attempt_id = at.id and e.type in ('copy', 'paste', 'contextmenu', 'print', 'key_block')),
      'device_conflicts', (select count(*) from public.events e where e.attempt_id = at.id and e.type = 'device_conflict'),
      'answers_after_return', (select count(*) from public.events e1 where e1.attempt_id = at.id and e1.type = 'answer'
                                 and exists (select 1 from public.events e2 where e2.attempt_id = at.id and e2.type = 'return'
                                              and e2.at <= e1.at and e2.at > e1.at - interval '20 seconds')),
      'adjust', (select coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'seconds', t.seconds, 'reason', t.reason)), '[]')
                   from public.time_adjustments t where t.attempt_id = at.id)
    ) as row
    from public.students s
    left join public.attempts at on at.student_no = s.student_no and at.round_no = p_round
  ) x;
  return jsonb_build_object('ok', true, 'students', v);
end $$;

-- 문항별 정답률
create function public.admin_item_stats(p_round int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v jsonb;
begin
  perform private.require_admin();
  with shown as (
    select (e.it ->> 'q')::bigint as qid,
           (a.answers ->> (e.ord - 1)::text)::int as mine
      from public.attempts a, jsonb_array_elements(a.items) with ordinality e(it, ord)
     where a.round_no = p_round and a.status = 'submitted'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'q_no', q.q_no, 'unit_no', q.unit_no, 'stem', q.stem,
           'shown', (select count(*) from shown where qid = q.id),
           'correct', (select count(*) from shown where qid = q.id and mine = q.answer)
         ) order by q.q_no), '[]') into v
    from public.questions q where q.round_no = p_round;
  return jsonb_build_object('ok', true, 'items', v);
end $$;

-- 학생별 문항 풀이 시간(문항을 본 시간 합)
create function public.admin_attempt_detail(p_attempt bigint) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v jsonb;
begin
  perform private.require_admin();
  select jsonb_build_object('ok', true,
    'events', (select coalesce(jsonb_agg(jsonb_build_object('type', type, 'item', item_index, 'detail', detail, 'at', at) order by at, id), '[]')
                 from public.events where attempt_id = p_attempt),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('no', e.ord, 'q_no', q.q_no, 'unit_no', q.unit_no,
                       'mine', (a.answers ->> (e.ord - 1)::text)::int, 'answer', q.answer) order by e.ord), '[]')
                from public.attempts a, jsonb_array_elements(a.items) with ordinality e(it, ord)
                join public.questions q on q.id = (e.it ->> 'q')::bigint
               where a.id = p_attempt))
    into v;
  return v;
end $$;

-- 코드 발급: 학년·반 수·최대 번호로 학번 전체 생성(이미 있으면 그대로)
create function public.admin_issue_codes(p_grade int, p_classes int, p_max_no int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c int; n int; v_no text; added int := 0;
begin
  perform private.require_admin();
  if p_grade not between 1 and 9 or p_classes not between 1 and 30 or p_max_no not between 1 and 60 then
    raise exception 'BAD_INPUT';
  end if;
  update public.settings set grade = p_grade where id = 1;
  for c in 1 .. p_classes loop
    for n in 1 .. p_max_no loop
      v_no := p_grade::text || lpad(c::text, 2, '0') || lpad(n::text, 2, '0');
      insert into public.students (student_no, class_no, code)
      values (v_no, c, private.rand_digits(6)) on conflict (student_no) do nothing;
      if found then added := added + 1; end if;
    end loop;
  end loop;
  return jsonb_build_object('ok', true, 'added', added);
end $$;

create function public.admin_reissue_code(p_student_no text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v text;
begin
  perform private.require_admin();
  v := private.rand_digits(6);
  update public.students set code = v, fail_count = 0, locked_until = null where student_no = p_student_no;
  return jsonb_build_object('ok', true, 'code', v);
end $$;

-- 재응시 허용(응시 기록을 지우고 새로 뽑게 함)
create function public.admin_reset_attempt(p_round int, p_student_no text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform private.require_admin();
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED'; end if;
  insert into public.audit_log (actor, action, detail)
  select auth.uid(), 'reset_attempt', jsonb_build_object('round', p_round, 'student', p_student_no, 'reason', p_reason,
         'score', a.score, 'status', a.status)
    from public.attempts a where a.round_no = p_round and a.student_no = p_student_no;
  delete from public.attempts where round_no = p_round and student_no = p_student_no;
  return jsonb_build_object('ok', true);
end $$;

-- 시간 복구(기기 고장 등, 교사 확인) / 편의 제공 연장(학교 규정 대상)
create function public.admin_adjust_time(p_attempt bigint, p_kind text, p_seconds int, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a public.attempts;
begin
  perform private.require_admin();
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED'; end if;
  select * into a from public.attempts where id = p_attempt for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  insert into public.time_adjustments (attempt_id, kind, seconds, reason, created_by)
  values (p_attempt, p_kind, p_seconds, p_reason, auth.uid());
  if a.status = 'submitted' then
    if a.submit_reason not in ('timeout', 'closed') then raise exception 'ALREADY_SUBMITTED'; end if;
    -- 시간 초과·마감으로 제출된 학생: 남은 시간을 주고 다시 풀게 함
    update public.attempts set status = 'in_progress', deadline = now() + make_interval(secs => p_seconds),
           extra_seconds = extra_seconds + p_seconds, submitted_at = null, submit_reason = null,
           correct_count = null, score = null
     where id = p_attempt;
  elsif a.started_at is null then
    update public.attempts set extra_seconds = extra_seconds + p_seconds where id = p_attempt;
  else
    update public.attempts set extra_seconds = extra_seconds + p_seconds,
           deadline = greatest(deadline, now()) + make_interval(secs => p_seconds)
     where id = p_attempt;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- 기기 교체 승인(고장 등)
create function public.admin_allow_device(p_attempt bigint) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform private.require_admin();
  update public.attempts set allow_device_change = true where id = p_attempt;
  insert into public.audit_log (actor, action, detail) values (auth.uid(), 'allow_device', jsonb_build_object('attempt', p_attempt));
  return jsonb_build_object('ok', true);
end $$;

-- 문항 가져오기(회차 문항 전체 교체; 응시 기록이 있으면 거부)
create function public.admin_import_questions(p_round int, p_units jsonb, p_questions jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  perform private.require_admin();
  if exists (select 1 from public.attempts where round_no = p_round) then
    raise exception 'HAS_ATTEMPTS';
  end if;
  delete from public.units where round_no = p_round;
  insert into public.units (round_no, unit_no, title)
  select p_round, (u ->> 'unit_no')::int, u ->> 'title' from jsonb_array_elements(p_units) u;
  insert into public.questions (round_no, unit_no, q_no, stem, options, answer, page, exclusion_group)
  select p_round, (q ->> 'unit_no')::int, (q ->> 'q_no')::int, q ->> 'stem', q -> 'options', (q ->> 'answer')::int,
         q ->> 'page', nullif(q ->> 'group', '')
    from jsonb_array_elements(p_questions) q;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'count', n);
end $$;

-- 오답 공개
create function public.admin_set_review(p_round int, p_released boolean) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform private.require_admin();
  update public.rounds set review_released = p_released where round_no = p_round;
  return jsonb_build_object('ok', true);
end $$;

-- 회차 응시 기록 전체 삭제(학기 정리)
create function public.admin_delete_records(p_round int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform private.require_admin();
  delete from public.attempts where round_no = p_round;
  delete from public.class_sessions where round_no = p_round;
  update public.rounds set review_released = false where round_no = p_round;
  insert into public.audit_log (actor, action, detail) values (auth.uid(), 'delete_records', jsonb_build_object('round', p_round));
  return jsonb_build_object('ok', true);
end $$;

-- 권한: 학생 함수는 누구나, 교사 함수는 로그인 사용자만(내부에서 교사 확인)
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.student_enter(int, text, text, text, text, boolean) to anon, authenticated;
grant execute on function public.student_start(text) to anon, authenticated;
grant execute on function public.student_answer(text, int, int) to anon, authenticated;
grant execute on function public.student_log(text, jsonb) to anon, authenticated;
grant execute on function public.student_submit(text) to anon, authenticated;
grant execute on function public.student_result(text, text) to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.claim_admin() to authenticated;
grant execute on function public.admin_open_session(int, int) to authenticated;
grant execute on function public.admin_close_session(int, int) to authenticated;
grant execute on function public.admin_monitor(int, int) to authenticated;
grant execute on function public.admin_results(int) to authenticated;
grant execute on function public.admin_item_stats(int) to authenticated;
grant execute on function public.admin_attempt_detail(bigint) to authenticated;
grant execute on function public.admin_issue_codes(int, int, int) to authenticated;
grant execute on function public.admin_reissue_code(text) to authenticated;
grant execute on function public.admin_reset_attempt(int, text, text) to authenticated;
grant execute on function public.admin_adjust_time(bigint, text, int, text) to authenticated;
grant execute on function public.admin_allow_device(bigint) to authenticated;
grant execute on function public.admin_import_questions(int, jsonb, jsonb) to authenticated;
grant execute on function public.admin_set_review(int, boolean) to authenticated;
grant execute on function public.admin_delete_records(int) to authenticated;
