-- 문제은행 수행평가: 테이블·보안(RLS)
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- 교사(관리자)
create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- 전체 설정(한 줄)
create table public.settings (
  id int primary key default 1 check (id = 1),
  grade int,                                   -- 코드 발급 학년
  allowed_ip_prefixes text[] not null default '{}',  -- 비어 있으면 제한 없음
  require_lockdown boolean not null default false     -- 잠금 모드 필수 여부
);
insert into public.settings default values;

-- 회차
create table public.rounds (
  round_no int primary key,
  title text not null,
  duration_min int not null default 20 check (duration_min between 1 and 180),
  question_count int not null default 20 check (question_count between 1 and 100),
  points_per_q int not null default 2,
  base_score int not null default 60,
  review_released boolean not null default false
);
insert into public.rounds (round_no, title) values (1, '1회 · 사무 환경 조성'), (2, '2회 · 자료 관리');

-- 단원
create table public.units (
  round_no int not null references public.rounds on delete cascade,
  unit_no int not null,
  title text not null,
  primary key (round_no, unit_no)
);

-- 문항 (원문 그대로)
create table public.questions (
  id bigint generated always as identity primary key,
  round_no int not null,
  unit_no int not null,
  q_no int not null,
  stem text not null,
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 5),
  answer int not null,
  page text,
  exclusion_group text,
  unique (round_no, q_no),
  foreign key (round_no, unit_no) references public.units on delete cascade,
  check (answer >= 0 and answer < jsonb_array_length(options))
);

-- 학생(학번·코드)
create table public.students (
  student_no text primary key check (student_no ~ '^[0-9]{5}$'),
  class_no int not null,
  code text not null,
  excluded boolean not null default false,     -- 응시 대상 아님(자퇴·전학 등)
  fail_count int not null default 0,
  locked_until timestamptz
);

-- 반별 회차 운영
create table public.class_sessions (
  round_no int not null references public.rounds on delete cascade,
  class_no int not null,
  is_open boolean not null default false,
  pin text,
  opened_at timestamptz,
  closed_at timestamptz,
  score_released boolean not null default false,
  primary key (round_no, class_no)
);

-- 응시
create table public.attempts (
  id bigint generated always as identity primary key,
  round_no int not null references public.rounds on delete cascade,
  student_no text not null references public.students on delete cascade,
  status text not null default 'ready' check (status in ('ready', 'in_progress', 'submitted')),
  token_hash text,
  device_id text,
  allow_device_change boolean not null default false,
  lockdown boolean not null default false,
  items jsonb not null,             -- [{q: 문항 id, perm: [표시 순서별 원래 보기 번호]}]
  answers jsonb not null default '{}',  -- {"표시 문항 번호": 원래 보기 번호}
  started_at timestamptz,
  deadline timestamptz,
  extra_seconds int not null default 0,
  submitted_at timestamptz,
  submit_reason text,
  correct_count int,
  score int,
  last_seen timestamptz,
  created_at timestamptz not null default now(),
  unique (round_no, student_no)
);
create index attempts_token_idx on public.attempts (token_hash);

-- 시간 연장·복구 기록
create table public.time_adjustments (
  id bigint generated always as identity primary key,
  attempt_id bigint not null references public.attempts on delete cascade,
  kind text not null check (kind in ('restore', 'accommodation')),
  seconds int not null check (seconds between 1 and 3600),
  reason text not null check (length(trim(reason)) > 0),
  created_by uuid,
  created_at timestamptz not null default now()
);

-- 응시 중 사건(이탈·복사 시도·답 선택 등)
create table public.events (
  id bigint generated always as identity primary key,
  attempt_id bigint not null references public.attempts on delete cascade,
  type text not null,
  item_index int,
  detail jsonb,
  at timestamptz not null default now()
);
create index events_attempt_idx on public.events (attempt_id, at);

-- 교사 조치 기록(재응시 허용 등)
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid,
  action text not null,
  detail jsonb,
  at timestamptz not null default now()
);

-- 교사 여부
create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- 첫 가입 교사가 관리자 자리를 차지(이후에는 늘지 않음)
create function public.claim_admin() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  perform pg_advisory_xact_lock(424242);
  if not exists (select 1 from public.admins) then
    insert into public.admins (user_id) values (auth.uid());
  end if;
  return public.is_admin();
end $$;

-- RLS: 모든 표는 교사만 직접 접근, 학생은 함수로만
do $$
declare t text;
begin
  foreach t in array array['admins','settings','rounds','units','questions','students','class_sessions','attempts','time_adjustments','events','audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.claim_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.claim_admin() to authenticated;
