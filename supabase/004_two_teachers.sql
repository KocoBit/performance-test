-- 교사 2명: 첫 계정은 바로 관리자, 그다음부터는 가입 → 승인 대기 → 기존 교사가 승인
alter table public.admins
  add column email text,
  add column approved boolean not null default true,
  add column classes int[] not null default '{}',
  add column approved_by uuid,
  add column approved_at timestamptz;

-- 학생 접속 안내에 함께 띄울 짧은 주소(선택)
alter table public.settings add column short_url text;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid() and approved);
$$;

drop function public.claim_admin();
create function public.claim_admin() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_email text := auth.jwt() ->> 'email'; r public.admins;
begin
  if auth.uid() is null then return jsonb_build_object('status', 'none'); end if;
  perform pg_advisory_xact_lock(424242);
  select * into r from public.admins where user_id = auth.uid();
  if not found then
    insert into public.admins (user_id, email, approved, approved_at)
    values (auth.uid(), v_email,
            not exists (select 1 from public.admins where approved),
            case when not exists (select 1 from public.admins where approved) then now() end)
    returning * into r;
  elsif r.email is distinct from v_email then
    update public.admins set email = v_email where user_id = auth.uid() returning * into r;
  end if;
  return jsonb_build_object('status', case when r.approved then 'approved' else 'pending' end,
                            'classes', to_jsonb(r.classes), 'email', r.email);
end $$;

create function public.admin_teachers() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform private.require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'user_id', user_id, 'email', email, 'approved', approved, 'classes', to_jsonb(classes),
            'me', user_id = auth.uid(), 'created_at', created_at) order by approved desc, created_at), '[]')
            from public.admins);
end $$;

-- 승인(true) 또는 거절·해제(false: 목록에서 지움). 자기 자신은 해제할 수 없다.
create function public.admin_set_teacher(p_user uuid, p_approved boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform private.require_admin();
  if p_user = auth.uid() and not p_approved then raise exception 'SELF'; end if;
  if p_approved then
    update public.admins set approved = true, approved_by = auth.uid(), approved_at = now() where user_id = p_user;
  else
    delete from public.admins where user_id = p_user;
  end if;
  insert into public.audit_log (actor, action, detail)
  values (auth.uid(), case when p_approved then 'approve_teacher' else 'remove_teacher' end, jsonb_build_object('user', p_user));
  return jsonb_build_object('ok', true);
end $$;

create function public.admin_set_my_classes(p_classes int[]) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform private.require_admin();
  update public.admins set classes = coalesce(p_classes, '{}') where user_id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.claim_admin() from public, anon;
revoke execute on function public.admin_teachers() from public, anon;
revoke execute on function public.admin_set_teacher(uuid, boolean) from public, anon;
revoke execute on function public.admin_set_my_classes(int[]) from public, anon;
grant execute on function public.claim_admin() to authenticated;
grant execute on function public.admin_teachers() to authenticated;
grant execute on function public.admin_set_teacher(uuid, boolean) to authenticated;
grant execute on function public.admin_set_my_classes(int[]) to authenticated;
