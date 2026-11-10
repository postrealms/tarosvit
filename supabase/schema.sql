-- Таросвіт — схема бази Supabase.
-- Запуск: Supabase → SQL Editor → New query → встав увесь файл → Run.
-- Скрипт можна запускати повторно: він нічого не дублює і не стирає дані.

-- ---------- Історія тлумачень ----------
create table if not exists public.readings (
  id          text primary key,                       -- генерується в застосунку
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  card        text not null,                          -- назва карти
  position    text,                                   -- «Пряме положення» / «Перевернуте положення»
  question    text,
  body        jsonb not null,                         -- абзаци тлумачення
  thumb       text check (thumb is null or length(thumb) < 60000)  -- мініатюра фото (data URL, ~8 КБ)
);
create index if not exists readings_user_created on public.readings (user_id, created_at desc);
alter table public.readings enable row level security;

drop policy if exists "readings: read own"   on public.readings;
drop policy if exists "readings: insert own" on public.readings;
drop policy if exists "readings: update own" on public.readings;
drop policy if exists "readings: delete own" on public.readings;
create policy "readings: read own"   on public.readings for select to authenticated using (auth.uid() = user_id);
create policy "readings: insert own" on public.readings for insert to authenticated with check (auth.uid() = user_id);
create policy "readings: update own" on public.readings for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "readings: delete own" on public.readings for delete to authenticated using (auth.uid() = user_id);

-- ---------- Денний ліміт тлумачень (пише тільки сервер) ----------
create table if not exists public.tarot_usage (
  user_id  uuid not null references auth.users(id) on delete cascade,
  day      date not null,
  count    int  not null default 0,
  primary key (user_id, day)
);
alter table public.tarot_usage enable row level security;
drop policy if exists "tarot_usage: read own" on public.tarot_usage;
create policy "tarot_usage: read own" on public.tarot_usage for select to authenticated using (auth.uid() = user_id);

-- +1 тлумачення, якщо ліміт не вичерпано. Повертає новий лічильник або NULL, коли ліміт досягнуто.
create or replace function public.use_reading(p_user uuid, p_limit int)
returns int language plpgsql security definer set search_path = public as $$
declare c int;
begin
  insert into public.tarot_usage as u (user_id, day, count)
  values (p_user, (now() at time zone 'Europe/Kyiv')::date, 1)
  on conflict (user_id, day) do update set count = u.count + 1 where u.count < p_limit
  returning u.count into c;
  return c;
end $$;

-- Повертає спробу в ліміт, якщо Claude не впорався (щоб збій не з'їдав спробу).
create or replace function public.refund_reading(p_user uuid)
returns void language sql security definer set search_path = public as $$
  update public.tarot_usage set count = greatest(count - 1, 0)
  where user_id = p_user and day = (now() at time zone 'Europe/Kyiv')::date;
$$;

revoke all on function public.use_reading(uuid, int) from public, anon, authenticated;
revoke all on function public.refund_reading(uuid)   from public, anon, authenticated;
grant execute on function public.use_reading(uuid, int) to service_role;
grant execute on function public.refund_reading(uuid)   to service_role;
