-- 다 같이 시작: 교사가 '시험 시작'을 누르면 반 전체가 같은 시각에 시작하고 같은 시각에 끝난다.
-- 늦게 들어온 학생은 남은 시간만 받는다(정당한 사유는 교사가 '시간 복구').
alter table public.class_sessions add column started_at timestamptz;
alter table public.attempts add column ready_at timestamptz;

-- 회차를 열 때마다 시작 전 상태로
create or replace function public.admin_open_session(p_round int, p_class int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_pin text;
begin
  perform private.require_admin();
  v_pin := private.rand_digits(4);
  insert into public.class_sessions (round_no, class_no, is_open, pin, opened_at, closed_at, started_at)
  values (p_round, p_class, true, v_pin, now(), null, null)
  on conflict (round_no, class_no) do update
     set is_open = true, pin = excluded.pin, opened_at = now(), closed_at = null, started_at = null;
  insert into public.audit_log (actor, action, detail)
  values (auth.uid(), 'open_session', jsonb_build_object('round', p_round, 'class', p_class));
  return jsonb_build_object('ok', true, 'pin', v_pin);
end $$;

-- 교사: 시험 시작
create function public.admin_start_exam(p_round int, p_class int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v timestamptz;
begin
  perform private.require_admin();
  update public.class_sessions set started_at = now()
   where round_no = p_round and class_no = p_class and is_open and started_at is null
  returning started_at into v;
  if v is null then raise exception 'NOT_STARTABLE'; end if;
  insert into public.audit_log (actor, action, detail)
  values (auth.uid(), 'start_exam', jsonb_build_object('round', p_round, 'class', p_class));
  return jsonb_build_object('ok', true, 'started_at', v);
end $$;

-- 학생: 준비 완료(전체 화면을 켠 상태로 대기)
create function public.student_ready(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a public.attempts;
begin
  a := private.attempt_by_token(p_token);
  if a.id is null then return private.err('SESSION'); end if;
  update public.attempts set ready_at = coalesce(ready_at, now()), last_seen = now() where id = a.id;
  return jsonb_build_object('ok', true);
end $$;

-- 학생: 시작했는지 확인(대기 화면에서 2초마다)
create function public.student_wait(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a public.attempts; cs public.class_sessions; r public.rounds; v_left int;
begin
  a := private.attempt_by_token(p_token);
  if a.id is null then return private.err('SESSION'); end if;
  update public.attempts set last_seen = now() where id = a.id;
  if a.status = 'submitted' then return private.err('ALREADY_SUBMITTED'); end if;
  select x.* into cs from public.class_sessions x join public.students s on s.class_no = x.class_no
   where x.round_no = a.round_no and s.student_no = a.student_no;
  if cs.round_no is null or not cs.is_open then return private.err('NOT_OPEN'); end if;
  select * into r from public.rounds where round_no = a.round_no;
  if cs.started_at is not null then
    v_left := greatest(0, ceil(extract(epoch from cs.started_at + make_interval(mins => r.duration_min)
                                                  + make_interval(secs => a.extra_seconds) - now())))::int;
  end if;
  return jsonb_build_object('ok', true, 'started', cs.started_at is not null, 'remaining', v_left);
end $$;

-- 시작: 교사가 시작한 뒤에만. 끝나는 시각 = 반 시작 시각 + 제한 시간 (+ 시간 조정)
create or replace function public.student_start(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a public.attempts; r public.rounds; cs public.class_sessions;
begin
  a := private.attempt_by_token(p_token);
  if a.id is null then return private.err('SESSION'); end if;
  perform private.finalize_if_expired(a.id);
  select * into a from public.attempts where id = a.id;
  if a.status = 'submitted' then return private.err('ALREADY_SUBMITTED'); end if;
  select x.* into cs from public.class_sessions x join public.students s on s.class_no = x.class_no
   where x.round_no = a.round_no and s.student_no = a.student_no;
  if cs.round_no is null or not cs.is_open then return private.err('NOT_OPEN'); end if;
  if cs.started_at is null then return private.err('WAITING'); end if;
  if a.started_at is null then
    select * into r from public.rounds where round_no = a.round_no;
    update public.attempts
       set started_at = now(), status = 'in_progress',
           deadline = cs.started_at + make_interval(mins => r.duration_min) + make_interval(secs => extra_seconds)
     where id = a.id returning * into a;
    insert into public.events (attempt_id, type, detail)
    values (a.id, 'start', jsonb_build_object('late_seconds', greatest(0, floor(extract(epoch from now() - cs.started_at)))::int));
    if a.deadline <= now() then
      perform private.finalize(a.id, 'timeout');
      return private.err('ALREADY_SUBMITTED');
    end if;
  end if;
  update public.attempts set last_seen = now() where id = a.id;
  return jsonb_build_object('ok', true, 'items', private.items_for_student(a),
                            'remaining', private.remaining(a), 'student_no', a.student_no);
end $$;

-- 감독 화면에 '준비 완료' 표시
create or replace function public.admin_monitor(p_round int, p_class int) returns jsonb
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
      'ready', at.ready_at is not null,
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

revoke execute on function public.admin_start_exam(int, int) from public, anon;
revoke execute on function public.student_ready(text) from public;
revoke execute on function public.student_wait(text) from public;
grant execute on function public.admin_start_exam(int, int) to authenticated;
grant execute on function public.student_ready(text) to anon, authenticated;
grant execute on function public.student_wait(text) to anon, authenticated;
