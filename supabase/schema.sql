-- ============================================================================
--  KaptainX Sales HQ: database schema (v2, sales only)
--  Paste the whole file into Supabase → SQL Editor → New query → Run.
--  Safe to run more than once. Upgrading from v1 removes the old Ideas tables.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 0. Remove v1 "Ideas" features and the old sign-up trigger (if present)
-- ---------------------------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user() cascade;
drop table if exists public.idea_prospects cascade;
drop table if exists public.notes cascade;
drop table if exists public.tasks cascade;
drop table if exists public.stages cascade;
drop table if exists public.ideas cascade;
drop table if exists public.members cascade;
drop function if exists public.sync_member() cascade;
drop function if exists public.stamp_task() cascade;

-- ---------------------------------------------------------------------------
-- 1. Team profiles (one per login). Created ONLY by the `team` edge function
--    or the admin script, never by public sign-up.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists name text;
alter table public.profiles add column if not exists role text;
alter table public.profiles add column if not exists color text;
alter table public.profiles add column if not exists daily_goal int not null default 40;
alter table public.profiles add column if not exists must_change_password boolean not null default true;
alter table public.profiles add column if not exists active boolean not null default true;
alter table public.profiles drop column if exists email;

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles drop constraint if exists profiles_role_chk;
alter table public.profiles add constraint profiles_role_chk check (role in ('founder','caller'));
alter table public.profiles drop constraint if exists profiles_goal_chk;
alter table public.profiles add constraint profiles_goal_chk check (daily_goal between 1 and 500);
alter table public.profiles drop constraint if exists profiles_text_chk;
alter table public.profiles add constraint profiles_text_chk check (
  length(coalesce(name,'')) <= 60 and username ~ '^[a-z0-9._-]{3,30}$' and color ~ '^#[0-9a-fA-F]{6}$') not valid;
create unique index if not exists profiles_username_key on public.profiles (lower(username));

-- ---------------------------------------------------------------------------
-- 2. Leads, calls, imports
-- ---------------------------------------------------------------------------
create table if not exists public.imports (
  id          uuid primary key default gen_random_uuid(),
  file_name   text,
  count       int not null default 0,
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

create table if not exists public.prospects (
  id            uuid primary key default gen_random_uuid(),
  name          text,           -- contact person
  company       text,           -- business name
  phone         text,
  email         text,
  city          text,
  website       text,
  notes         text,
  stage         text not null default 'new',
  import_id     uuid references public.imports on delete set null,
  next_followup date,
  call_count    int not null default 0,
  last_call_at  timestamptz,
  created_by    uuid references public.profiles(id) on delete set null default auth.uid(),
  updated_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- v1 → v2: "industry" becomes "domain"; add "pitch"
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='prospects' and column_name='industry')
     and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='prospects' and column_name='domain') then
    alter table public.prospects rename column industry to domain;
  end if;
end $$;
alter table public.prospects add column if not exists domain text;   -- industry / niche, e.g. Dental, Manufacturing
alter table public.prospects add column if not exists pitch text;    -- what to pitch, e.g. Donna
alter table public.prospects add column if not exists problem text;    -- what's wrong for them (how to approach)
alter table public.prospects add column if not exists opener text;     -- suggested first line on the call
alter table public.prospects add column if not exists best_time text;  -- best time to call (IST)
alter table public.prospects add column if not exists timezone text;   -- their time zone, e.g. Eastern (ET)
alter table public.prospects add column if not exists score int;       -- lead score 0-100
alter table public.prospects drop constraint if exists prospects_stage_check;
alter table public.prospects drop constraint if exists prospects_stage_chk;
alter table public.prospects add constraint prospects_stage_chk
  check (stage in ('new','called','interested','meeting','proposal','client','lost'));
alter table public.prospects drop constraint if exists prospects_text_chk;
alter table public.prospects add constraint prospects_text_chk check (
      length(coalesce(name,''))    <= 200 and length(coalesce(company,'')) <= 200
  and length(coalesce(phone,''))   <= 40  and length(coalesce(email,''))   <= 200
  and length(coalesce(city,''))    <= 120 and length(coalesce(domain,''))  <= 120
  and length(coalesce(pitch,''))   <= 300 and length(coalesce(website,'')) <= 500
  and length(coalesce(notes,''))   <= 5000
  and length(coalesce(problem,'')) <= 1000 and length(coalesce(opener,''))  <= 1000
  and length(coalesce(best_time,'')) <= 300 and length(coalesce(timezone,'')) <= 60
  and (score is null or score between 0 and 100)
  and (website is null or website ~* '^https?://[^[:space:]<>"]+$')) not valid;
create index if not exists prospects_stage_idx on public.prospects(stage);
create index if not exists prospects_domain_idx on public.prospects(lower(domain));
create index if not exists prospects_score_idx on public.prospects(score desc nulls last);

create table if not exists public.calls (
  id          uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.prospects on delete cascade,
  caller      uuid references public.profiles(id) on delete set null default auth.uid(),
  outcome     text not null check (outcome in ('no_answer','callback','not_interested','interested')),
  note        text,
  followup    date,
  created_at  timestamptz not null default now()
);
alter table public.calls drop constraint if exists calls_note_chk;
alter table public.calls add constraint calls_note_chk check (length(coalesce(note,'')) <= 1000) not valid;
create index if not exists calls_prospect_idx on public.calls(prospect_id);
create index if not exists calls_created_idx on public.calls(created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Activity log (written only by triggers and the team function)
-- ---------------------------------------------------------------------------
create table if not exists public.activity (
  id          bigint generated always as identity primary key,
  actor       uuid references public.profiles(id) on delete set null,
  scope       text not null,
  entity      text not null,
  entity_id   uuid,
  prospect_id uuid,
  action      text not null,
  label       text,
  changes     jsonb,
  created_at  timestamptz not null default now()
);
alter table public.activity drop column if exists idea_id;
delete from public.activity where scope not in ('sales','team');
alter table public.activity drop constraint if exists activity_scope_check;
alter table public.activity drop constraint if exists activity_scope_chk;
alter table public.activity add constraint activity_scope_chk check (scope in ('sales','team'));
create index if not exists activity_created_idx on public.activity(created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Role helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select active and role is not null from public.profiles where id = auth.uid()), false)
$$;
create or replace function public.is_founder() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select active and role = 'founder' from public.profiles where id = auth.uid()), false)
$$;
drop function if exists public.my_role();

-- Tiny health check used by the optional keep-alive cron
create or replace function public.ping() returns boolean
language sql stable security definer set search_path = public as $$ select true $$;

-- ---------------------------------------------------------------------------
-- 5. Stamps: who created / last edited (cannot be faked by the browser)
-- ---------------------------------------------------------------------------
create or replace function public.stamp() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.updated_at := now();
  return new;
end $$;

create or replace function public.stamp_creator() returns trigger
language plpgsql as $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.created_at := now();
  return new;
end $$;

drop trigger if exists prospects_stamp on public.prospects;
create trigger prospects_stamp before insert or update on public.prospects
  for each row execute function public.stamp();
drop trigger if exists imports_stamp on public.imports;
create trigger imports_stamp before insert on public.imports
  for each row execute function public.stamp_creator();

create or replace function public.stamp_call() returns trigger
language plpgsql as $$
begin
  new.caller := coalesce(auth.uid(), new.caller);
  new.created_at := now();
  return new;
end $$;
drop trigger if exists calls_stamp on public.calls;
create trigger calls_stamp before insert on public.calls
  for each row execute function public.stamp_call();

-- ---------------------------------------------------------------------------
-- 6. Audit trigger → activity
-- ---------------------------------------------------------------------------
create or replace function public.audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  r jsonb := coalesce(n, o);
  diff jsonb := '{}'::jsonb;
  k text;
  lbl text;
  v_prospect uuid;
begin
  if tg_op = 'DELETE' and tg_table_name = 'calls'
     and not exists (select 1 from public.prospects where id = (r->>'prospect_id')::uuid) then return null; end if;
  if tg_table_name = 'prospects' and tg_op = 'INSERT' and r->>'import_id' is not null then return null; end if;
  if tg_table_name = 'prospects' and tg_op = 'UPDATE' and current_setting('kx.from_call', true) = '1' then return null; end if;

  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(n) loop
      if k not in ('updated_at','updated_by','created_at','created_by','call_count','last_call_at')
         and (n->k) is distinct from (o->k) then
        diff := diff || jsonb_build_object(k, jsonb_build_array(o->k, n->k));
      end if;
    end loop;
    if diff = '{}'::jsonb then return null; end if;
  end if;

  v_prospect := case tg_table_name when 'prospects' then (r->>'id')::uuid else (r->>'prospect_id')::uuid end;
  lbl := coalesce(nullif(r->>'name',''), nullif(r->>'company',''), r->>'file_name');
  if tg_table_name = 'calls' then
    select coalesce(nullif(name,''), company) into lbl from public.prospects where id = v_prospect;
    diff := jsonb_build_object('outcome', r->'outcome', 'note', r->'note');
  end if;
  if tg_table_name = 'imports' then diff := jsonb_build_object('count', r->'count'); end if;

  insert into public.activity (actor, scope, entity, entity_id, prospect_id, action, label, changes)
  values (auth.uid(), 'sales', tg_table_name, (r->>'id')::uuid, v_prospect,
          lower(tg_op), left(lbl, 200), case when diff = '{}'::jsonb then null else diff end);
  return null;
end $$;

do $$ declare t text; begin
  foreach t in array array['prospects','calls','imports'] loop
    execute format('drop trigger if exists %1$s_audit on public.%1$s', t);
    execute format('create trigger %1$s_audit after insert or update or delete on public.%1$s for each row execute function public.audit()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Logging a call moves the lead along the pipeline automatically
-- ---------------------------------------------------------------------------
create or replace function public.on_call() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('kx.from_call', '1', true);
  update public.prospects p set
    call_count    = p.call_count + 1,
    last_call_at  = new.created_at,
    next_followup = case when new.outcome = 'callback' then coalesce(new.followup, current_date + 1) else p.next_followup end,
    stage = case
      when new.outcome = 'interested'     and p.stage in ('new','called','lost') then 'interested'
      when new.outcome = 'not_interested' and p.stage in ('new','called')        then 'lost'
      when p.stage = 'new'                                                      then 'called'
      else p.stage end
  where p.id = new.prospect_id;
  perform set_config('kx.from_call', '', true);
  return new;
end $$;
drop trigger if exists calls_after on public.calls;
create trigger calls_after after insert on public.calls
  for each row execute function public.on_call();

create or replace function public.on_call_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('kx.from_call', '1', true);
  update public.prospects set call_count = greatest(0, call_count - 1) where id = old.prospect_id;
  perform set_config('kx.from_call', '', true);
  return old;
end $$;
drop trigger if exists calls_after_delete on public.calls;
create trigger calls_after_delete after delete on public.calls
  for each row execute function public.on_call_delete();

-- ---------------------------------------------------------------------------
-- 8. Row-level security
--    Founders: everything + delete leads.  Callers: read/add/edit leads, log calls.
--    Anyone not in profiles (or deactivated): nothing.
-- ---------------------------------------------------------------------------
alter table public.profiles  enable row level security;
alter table public.prospects enable row level security;
alter table public.calls     enable row level security;
alter table public.imports   enable row level security;
alter table public.activity  enable row level security;

do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
           and tablename in ('profiles','prospects','calls','imports','activity')
  loop execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename); end loop;
end $$;

create policy profiles_read       on public.profiles for select using (public.is_member() or id = auth.uid());
create policy profiles_update_own on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

create policy prospects_read   on public.prospects for select using (public.is_member());
create policy prospects_insert on public.prospects for insert with check (public.is_member());
create policy prospects_update on public.prospects for update using (public.is_member()) with check (public.is_member());
create policy prospects_delete on public.prospects for delete using (public.is_founder());

create policy calls_read   on public.calls for select using (public.is_member());
create policy calls_insert on public.calls for insert with check (public.is_member() and caller = auth.uid());
create policy calls_delete on public.calls for delete using (public.is_member() and (caller = auth.uid() or public.is_founder()));

create policy imports_read   on public.imports for select using (public.is_member());
create policy imports_insert on public.imports for insert with check (public.is_member());

create policy activity_read on public.activity for select using (public.is_member());

-- Least privilege: the browser key (anon) gets nothing; signed-in users get only what they need.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, public;
grant usage on schema public to anon, authenticated;
grant select on public.profiles to authenticated;
grant update (name, daily_goal, must_change_password) on public.profiles to authenticated;
grant select, insert, update, delete on public.prospects to authenticated;
grant select, insert, delete on public.calls to authenticated;
grant select, insert on public.imports to authenticated;
grant select on public.activity to authenticated;
grant execute on function public.is_member(), public.is_founder() to authenticated;
grant execute on function public.ping() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Live updates
-- ---------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['prospects','calls','imports','activity','profiles'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
