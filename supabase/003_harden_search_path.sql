-- 내부 함수의 search_path 고정(보안 점검 권고)
alter function private.err(text, jsonb) set search_path = '';
alter function private.sha(text) set search_path = '';
alter function private.client_ip() set search_path = '';
alter function private.rand_digits(int) set search_path = '';
alter function private.draw_items(int) set search_path = '';
alter function private.finalize(bigint, text) set search_path = '';
alter function private.finalize_if_expired(bigint) set search_path = '';
alter function private.attempt_by_token(text) set search_path = '';
alter function private.items_for_student(public.attempts) set search_path = '';
alter function private.remaining(public.attempts) set search_path = '';
alter function private.require_admin() set search_path = '';
