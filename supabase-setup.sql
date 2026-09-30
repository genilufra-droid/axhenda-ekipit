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

-- Gati! Kthehu te aplikacioni → butoni "☁️" → vendos:
--   Supabase URL   = Settings → API → Project URL
--   anon key       = Settings → API → Project API keys → anon public
--   Kodi i ekipit  = çfarëdo teksti (i njëjti për të gjithë punonjësit)
