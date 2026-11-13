-- Check System · 99 Jiu-Jitsu México
-- Esquema de la base de datos en Supabase: cuentas con rol, datos de la app y pantallas en vivo.
-- Roles: admin (todo), profe (asistencia, cobros, marcador), pantalla (solo ver), pendiente (sin acceso).
-- La primera cuenta que se registra queda como admin; las demás esperan aprobación.

-- ============ cuentas del equipo ============
create table if not exists public.miembros (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  nombre   text not null default '',
  email    text not null default '',
  rol      text not null default 'pendiente' check (rol in ('admin', 'profe', 'pantalla', 'pendiente')),
  creado   timestamptz not null default now()
);
alter table public.miembros enable row level security;

-- ============ datos de la app (alumnos, asistencia, pagos, cuota, estado en vivo) ============
create table if not exists public.docs (
  path            text primary key
                  check (length(path) <= 1000
                         and path ~ '^[A-Za-z0-9_.~:@+-]{1,200}(/[A-Za-z0-9_.~:@+-]{1,200})*$'
                         and array_length(string_to_array(path, '/'), 1) % 2 = 0),
  coll            text generated always as (regexp_replace(path, '/[^/]+$', '')) stored,
  data            jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 300000),
  v               integer not null default 1,
  actualizado     timestamptz not null default now(),
  actualizado_por uuid references auth.users(id) on delete set null
);
create index if not exists docs_coll_idx on public.docs (coll);
alter table public.docs enable row level security;

revoke all on public.miembros, public.docs from anon;

-- ============ quién es quién (en un esquema privado, fuera del API público) ============
create schema if not exists privado;
revoke all on schema privado from public, anon;
grant usage on schema privado to authenticated;
create or replace function privado.es_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select rol in ('admin', 'profe', 'pantalla') from public.miembros where user_id = auth.uid()), false)
$$;
create or replace function privado.es_editor() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select rol in ('admin', 'profe') from public.miembros where user_id = auth.uid()), false)
$$;
create or replace function privado.es_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select rol = 'admin' from public.miembros where user_id = auth.uid()), false)
$$;
revoke execute on function privado.es_staff(), privado.es_editor(), privado.es_admin() from public, anon;
grant execute on function privado.es_staff(), privado.es_editor(), privado.es_admin() to authenticated;

-- al registrarse alguien: la primera cuenta es admin, las demás quedan pendientes
create or replace function public.nuevo_miembro() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.miembros (user_id, nombre, email, rol)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'nombre'), ''), split_part(coalesce(new.email, ''), '@', 1)),
    coalesce(new.email, ''),
    case when exists (select 1 from public.miembros where rol = 'admin') then 'pendiente' else 'admin' end
  )
  on conflict (user_id) do nothing;
  return new;
end $$;
revoke execute on function public.nuevo_miembro() from public, anon, authenticated;
drop trigger if exists al_crear_usuario on auth.users;
create trigger al_crear_usuario after insert on auth.users for each row execute function public.nuevo_miembro();

-- siempre debe quedar al menos un admin
create or replace function public.cuidar_admins() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.rol = 'admin' and (tg_op = 'DELETE' or new.rol <> 'admin')
     and (select count(*) from public.miembros where rol = 'admin') <= 1 then
    raise exception 'Debe quedar al menos un administrador';
  end if;
  return coalesce(new, old);
end $$;
revoke execute on function public.cuidar_admins() from public, anon, authenticated;
drop trigger if exists cuidar_admins on public.miembros;
create trigger cuidar_admins before update or delete on public.miembros for each row execute function public.cuidar_admins();

-- ============ permisos ============
drop policy if exists "ver miembros" on public.miembros;
create policy "ver miembros" on public.miembros for select to authenticated
  using (user_id = (select auth.uid()) or (select privado.es_staff()));
drop policy if exists "admin cambia roles" on public.miembros;
create policy "admin cambia roles" on public.miembros for update to authenticated
  using ((select privado.es_admin())) with check ((select privado.es_admin()));
drop policy if exists "admin quita cuentas" on public.miembros;
create policy "admin quita cuentas" on public.miembros for delete to authenticated
  using ((select privado.es_admin()) and user_id <> (select auth.uid()));

drop policy if exists "staff lee" on public.docs;
create policy "staff lee" on public.docs for select to authenticated using ((select privado.es_staff()));
drop policy if exists "editores crean" on public.docs;
create policy "editores crean" on public.docs for insert to authenticated with check ((select privado.es_editor()));
drop policy if exists "editores cambian" on public.docs;
create policy "editores cambian" on public.docs for update to authenticated
  using ((select privado.es_editor())) with check ((select privado.es_editor()));
drop policy if exists "editores borran" on public.docs;
create policy "editores borran" on public.docs for delete to authenticated using ((select privado.es_editor()));

-- ============ escribir datos ============
create or replace function public.jsonb_merge_deep(a jsonb, b jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare k text; val jsonb; r jsonb;
begin
  if a is null or jsonb_typeof(a) <> 'object' or jsonb_typeof(b) <> 'object' then return b; end if;
  r := a;
  for k, val in select key, value from jsonb_each(b) loop
    if jsonb_typeof(r -> k) = 'object' and jsonb_typeof(val) = 'object' then
      r := r || jsonb_build_object(k, public.jsonb_merge_deep(r -> k, val));
    else
      r := r || jsonb_build_object(k, val);
    end if;
  end loop;
  return r;
end $$;

create or replace function public.doc_set(p text, d jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare r public.docs;
begin
  insert into public.docs as t (path, data, actualizado_por) values (p, d, auth.uid())
  on conflict (path) do update set data = excluded.data, v = t.v + 1, actualizado = now(), actualizado_por = auth.uid()
  returning * into r;
  return jsonb_build_object('data', r.data, 'v', r.v);
end $$;

create or replace function public.doc_update(p text, d jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare r public.docs;
begin
  update public.docs as t
     set data = public.jsonb_merge_deep(t.data, d), v = t.v + 1, actualizado = now(), actualizado_por = auth.uid()
   where t.path = p
  returning * into r;
  if not found then raise exception 'no existe' using errcode = 'P0002'; end if;
  return jsonb_build_object('data', r.data, 'v', r.v);
end $$;
revoke execute on function public.jsonb_merge_deep(jsonb, jsonb), public.doc_set(text, jsonb), public.doc_update(text, jsonb) from public, anon;
grant execute on function public.jsonb_merge_deep(jsonb, jsonb) to authenticated;
grant execute on function public.doc_set(text, jsonb), public.doc_update(text, jsonb) to authenticated;

-- ============ tiempo real ============
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- canal privado de las pantallas: el equipo escucha y se marca presente; solo admin y profes mandan
drop policy if exists "staff escucha en vivo" on realtime.messages;
create policy "staff escucha en vivo" on realtime.messages for select to authenticated
  using (realtime.topic() = 'check-system-live' and (select privado.es_staff()));
drop policy if exists "equipo manda en vivo" on realtime.messages;
create policy "equipo manda en vivo" on realtime.messages for insert to authenticated
  with check (
    realtime.topic() = 'check-system-live'
    and ((extension = 'presence' and (select privado.es_staff()))
         or (extension = 'broadcast' and (select privado.es_editor())))
  );
