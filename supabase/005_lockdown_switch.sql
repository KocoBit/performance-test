-- 잠금 모드(윈도우 테스트 응시) 사용 여부: 학교 기기에서 확인되기 전에는 끔
alter table public.settings add column use_lockdown boolean not null default false;
update public.settings set require_lockdown = false where not use_lockdown;
alter table public.settings add constraint require_needs_use check (not require_lockdown or use_lockdown);

-- 학생 화면이 읽는 공개 설정(민감 정보 없음)
create function public.student_config() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('use_lockdown', use_lockdown, 'require_lockdown', require_lockdown)
    from public.settings where id = 1;
$$;
revoke execute on function public.student_config() from public;
grant execute on function public.student_config() to anon, authenticated;
