-- ============================================================
--  Axhenda Online — Konfigurimi i databazës Supabase (FALAS)
--  Ekzekutoje këtë te: Supabase → SQL Editor → New query → Run
--  (I sigurt për t'u ekzekutuar disa herë — nuk jep gabim.)
-- ============================================================

-- 1) Tabela ku ruhet e gjithë "dhoma" e ekipit (një rresht për çdo Kod ekipi)
create table if not exists public.axhenda (
  id          text primary key,        -- Kodi i ekipit (dhoma), p.sh. 'ekipi-im-2026'
  data        jsonb,                   -- të gjitha detyrat, mesazhet, sms (JSON)
  by          text,                    -- kush e bëri ndryshimin e fundit (client id)
  updated_at  timestamptz default now()
);

-- 2) Aktivizo Row Level Security
alter table public.axhenda enable row level security;

-- 3) Politika për PROTOTIP: kushdo me anon key + Kod ekipi mund të lexojë/shkruajë
--    (Për prodhim, zëvendësoje me politika që kërkojnë login/auth.)
drop policy if exists "axhenda_public_rw" on public.axhenda;
create policy "axhenda_public_rw"
  on public.axhenda
  for all
  using (true)
  with check (true);

-- 4) Aktivizo Realtime — VETËM nëse tabela s'është shtuar tashmë
--    (kjo shmang gabimin "already member of publication")
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'axhenda'
  ) then
    alter publication supabase_realtime add table public.axhenda;
  end if;
end $$;

-- ============================================================
--  CHAT 1:1 SI WHATSAPP — Read receipts, typing, online status
--  (Shtesat më poshtë janë të sigurta për t'u ekzekutuar disa herë.)
-- ============================================================

-- 5) Kolona `is_read` te chat_messages — tregon nëse marrësi e ka lexuar mesazhin
--    (Shtohet vetëm nëse tabela 'chat_messages' ekziston dhe kolona mungon.)
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'chat_messages'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'chat_messages' and column_name = 'is_read'
  ) then
    alter table public.chat_messages add column is_read boolean default false;
  end if;
end $$;

-- 5b) Politikë RLS: lejo MARRËSIN e mesazhit të përditësojë is_read (read receipts)
--     (Shtohet vetëm nëse tabela 'chat_messages' ekziston.)
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'chat_messages'
  ) then
    drop policy if exists "chat_mark_read" on public.chat_messages;
    create policy "chat_mark_read"
      on public.chat_messages
      for update
      using (auth.uid() = recipient_id)
      with check (auth.uid() = recipient_id);
  end if;
end $$;

-- 6) Tabela `user_presence` — ruan statusin online/offline dhe "po shkruan..."
--    user_id            = përdoruesi (lidhet me auth.users)
--    is_online          = a është aktualisht online
--    last_seen          = koha e fundit që u pa aktiv
--    is_typing_to       = te kush po shkruan tani (null kur s'po shkruan)
--    typing_updated_at   = koha kur u përditësua statusi i të shkruarit
create table if not exists public.user_presence (
  user_id            uuid references auth.users primary key,
  is_online          boolean default false,
  last_seen          timestamptz default now(),
  is_typing_to       uuid references auth.users,
  typing_updated_at  timestamptz
);

-- 7) Aktivizo Row Level Security për user_presence
alter table public.user_presence enable row level security;

-- 8) Politikat RLS për user_presence
--    - Çdo përdorues i loguar mund të LEXOJË prezencën e të gjithëve
--      (që të shfaqet dot-i online/offline dhe "po shkruan...")
drop policy if exists "presence_select_all" on public.user_presence;
create policy "presence_select_all"
  on public.user_presence
  for select
  using (auth.role() = 'authenticated');

--    - Çdo përdorues mund të SHKRUAJË (insert) vetëm rreshtin e vet
drop policy if exists "presence_insert_own" on public.user_presence;
create policy "presence_insert_own"
  on public.user_presence
  for insert
  with check (auth.uid() = user_id);

--    - Çdo përdorues mund të PËRDITËSOJË (update) vetëm rreshtin e vet
drop policy if exists "presence_update_own" on public.user_presence;
create policy "presence_update_own"
  on public.user_presence
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 9) Aktivizo Realtime për user_presence (vetëm nëse s'është shtuar tashmë)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'user_presence'
  ) then
    alter publication supabase_realtime add table public.user_presence;
  end if;
end $$;

-- 10) Sigurohu që chat_messages është në Realtime (për read receipts në kohë reale)
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'chat_messages'
  ) and not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;

-- ============================================================
-- 11) MENAXHIMI I PUNONJËSVE (tabela + foto në Storage)
-- ============================================================

-- 11a) Tabela e punonjësve me të dhëna të plota
create table if not exists public.punonjesit (
  id            uuid default gen_random_uuid() primary key,
  team_id       text not null,            -- Kodi i ekipit (i njëjti si "dhoma")
  emri          text not null,
  mbiemri       text not null,
  email         text,
  telefon       text,
  roli          text default 'punonjes',  -- 'pronar' | 'menaxher' | 'punonjes'
  foto_url      text,                     -- URL publike e fotos nga Supabase Storage
  departamenti  text,
  data_fillimit date,
  shenim        text,
  aktiv         boolean default true,
  krijuar_me    timestamptz default now(),
  perdorues_id  text                      -- (opsionale) lidhja me chat user id
);

create index if not exists punonjesit_team_idx on public.punonjesit(team_id);

alter table public.punonjesit enable row level security;

-- Policy e hapur (si tabelat e tjera të këtij projekti). Mund ta ngushtosh më vonë.
drop policy if exists "punonjesit_public_rw" on public.punonjesit;
create policy "punonjesit_public_rw"
  on public.punonjesit for all
  using (true) with check (true);

-- 11b) Aktivizo Realtime për punonjesit
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'punonjesit'
  ) then
    alter publication supabase_realtime add table public.punonjesit;
  end if;
end $$;

-- 11c) Storage bucket publik për fotot e punonjësve
insert into storage.buckets (id, name, public)
values ('employee-photos', 'employee-photos', true)
on conflict (id) do nothing;

-- Lexim publik i fotove
drop policy if exists "photos_public_read" on storage.objects;
create policy "photos_public_read"
  on storage.objects for select
  using (bucket_id = 'employee-photos');

-- Ngarkim fotosh
drop policy if exists "photos_public_upload" on storage.objects;
create policy "photos_public_upload"
  on storage.objects for insert
  with check (bucket_id = 'employee-photos');

-- Përditësim fotosh
drop policy if exists "photos_public_update" on storage.objects;
create policy "photos_public_update"
  on storage.objects for update
  using (bucket_id = 'employee-photos');

-- Fshirje fotosh
drop policy if exists "photos_public_delete" on storage.objects;
create policy "photos_public_delete"
  on storage.objects for delete
  using (bucket_id = 'employee-photos');

-- Gati! Kthehu te aplikacioni → butoni "☁️" → vendos:
--   Supabase URL   = Settings → API → Project URL
--   anon key       = Settings → API → Project API keys → anon public
--   Kodi i ekipit  = çfarëdo teksti (i njëjti për të gjithë punonjësit)
--
-- SHËNIM: Pas ekzekutimit të seksionit 11, seksioni "👥 Punonjësit" në aplikacion
-- (i dukshëm vetëm për pronarin/menaxherin) do të funksionojë plotësisht:
-- shtim/ndryshim/fshirje punonjësish me foto (ngarkohen në bucket-in employee-photos).
