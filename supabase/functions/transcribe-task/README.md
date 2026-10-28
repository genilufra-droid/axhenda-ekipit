# Asistenti i detyrave (tekst + audio)

Funksioni `transcribe-task` transkripton audio në shqip dhe kthen një **propozim** detyre (`{ transcript, draft: { title, assignee, due, priority } }`). Nuk ruan detyra, nuk dërgon njoftime dhe nuk ruan skedarë audio në Storage. Ndryshimet ruhen vetëm pas konfirmimit në ndërfaqe.

## Zgjedhja e ofruesit AI (server-side)

Zgjedhja e ofruesit bëhet vetëm në server sipas sekreteve të konfiguruara, në këtë rend:

1. **`GROQ_API_KEY` (falas — i rekomanduar):**
   - Transkriptim audio: `whisper-large-v3-turbo` (`language=sq`) te `https://api.groq.com/openai/v1/audio/transcriptions` (opsionale: `GROQ_WHISPER_MODEL`).
   - Propozim detyre: `llama-3.3-70b-versatile` me `response_format: { type: "json_object" }` (opsionale: `GROQ_TASK_MODEL`).
2. **`OPENAI_API_KEY` (opsional / rezervë):**
   - Transkriptim audio: `whisper-1` (`language=sq`) te `https://api.openai.com/v1/audio/transcriptions` (opsionale: `OPENAI_WHISPER_MODEL`).
   - Propozim detyre: `gpt-4o-mini` me JSON Schema (opsionale: `OPENAI_TASK_MODEL`).
3. **Fallback automatik:**
   - Nëse ofruesi i parë dështon për kuotë/kredi ose pamundësi shërbimi, provohet automatikisht ofruesi tjetër nëse çelësi i tij ekziston.
   - Për propozimin e detyrës përdoret së pari i njëjti ofrues që kreu transkriptimin; nëse modeli i propozimit nuk është i disponueshëm pasi audioja u transkriptua, përdoret parsuesi lokal deterministik në server që të mos humbasë transkriptimi.

## Aktivizimi

1. Projekti duhet të ketë Supabase Auth dhe tabelën ekzistuese `public.profiles` me `id`, `role`, `display_name`. Pronari duhet të ketë `role = 'owner'`. Mbaj RLS aktive; funksioni lexon profilet me token-in e përdoruesit dhe nuk përdor service-role key.
2. Merr një çelës falas te **https://console.groq.com/keys** dhe shtoje si sekret `GROQ_API_KEY` te **Supabase Dashboard → Edge Functions → Secrets** (ose me CLI: `supabase secrets set GROQ_API_KEY=gsk_... --project-ref ID_E_PROJEKTIT`). Mos e vendos kurrë çelësin në HTML, Git ose `localStorage`. Opsionalisht mund të mbash edhe `OPENAI_API_KEY` si rezervë.
3. Publiko funksionin nga kjo dosje/repository:

   ```sh
   supabase functions deploy transcribe-task --project-ref ID_E_PROJEKTIT
   ```

   Mos përdor `--no-verify-jwt`. Përveç verifikimit në gateway, funksioni verifikon përdoruesin në Auth dhe rolin `owner` në databazë.
4. Publiko **edhe `task-assistant.js` dhe `voice-dictation.js` pranë `index.html`**. Hap aplikacionin me HTTPS për mikrofonin.

`SUPABASE_URL` dhe `SUPABASE_ANON_KEY` ofrohen nga mjedisi i funksioneve. Nuk kërkohet migrim i ri i databazës. Ky ndryshim në repository nuk e publikon vetë funksionin dhe nuk vendos secrets.

## Sjellja

- Tekst: shkruaj p.sh. “Cakto Arben Kola të përgatisë raportin nesër, urgjent” dhe shtyp **✨ AI**.
- Audio: shtyp **një herë** mikrofonin dhe fol. Teksti shfaqet drejtpërdrejt në panelin “Po dëgjoj…”. Regjistrimi ndalon vetë kur mikrofonit i mungon **zë real për 3 sekonda të plota** (matet me RMS nga Web Audio API, jo nga mungesa e rezultateve të SpeechRecognition). Çdo fjalë e re e rifillon numërimin; pauzat e shkurtra dhe zëri i ulët nuk e ndërpresin. Kufiri i një diktimi është 60 sekonda; një klikim i dytë ndalon menjëherë.
- Kur transkriptimi live ka dhënë tekst, dërgohet **vetëm teksti** (asnjëherë audio shtesë).
- Pas ndalimit hapet automatikisht dritarja **“Konfirmo dërgimin”** me titull, përshkrim/transkriptim, punonjës, afat dhe prioritet. Asgjë nuk ruhet dhe asnjë SMS/Email nuk dërgohet pa shtypur **“Konfirmo dhe dërgo”**; **“Anulo”** nuk ruan dhe nuk njofton. Njoftimi është zgjedhje e veçantë brenda kësaj dritareje dhe nuk trashëgohet nga shiriti i kompozimit.
- Pa zë ose me transkriptim bosh dritarja e konfirmimit **nuk hapet**.
- Nëse browser-i nuk ofron transkriptim të drejtpërdrejtë në shqip (p.sh. Samsung Internet në Android ose disa versione iOS/Safari), audioja dërgohet te `transcribe-task` dhe transkriptohet në server pas ndalimit.
- **Escape** (ose butoni “Anulo” në panel) anulon regjistrimin/kërkesën ose mbyll propozimin. Mikrofoni dhe `AudioContext` lirohen gjithmonë: pas ndalimit, gabimit, anulimit dhe largimit nga faqja (`pagehide`).
- Kur serveri dështon ose nuk ka provider dhe ekziston tekst (i shkruar ose nga diktimi live), aplikacioni kalon automatikisht te `TaskAssistant.parse` dhe hap **“Konfirmo dërgimin”** me shënimin e qartë **“Përpunim lokal — AI nuk u përdor”**.

## Kur shfaqet “Audioja nuk u transkriptua: …”

Arsyeja në shqip shfaqet në ekran dhe detajet diagnostike shfaqen poshtë me butonin **“Kopjo detajet”** (pa ekspozuar çelësa ose përgjigje të papërpunuara të ofruesit):

| Arsyeja në ekran | Statusi | Shkaku dhe zgjidhja |
|---|---|---|
| `funksioni transcribe-task nuk është publikuar (404)` | 404 | Publiko me `supabase functions deploy transcribe-task --project-ref <REF>` |
| `Sesioni ka skaduar. Hyr përsëri.` | 401 | Token i skaduar ose mungon — hyr sërish në aplikacion |
| `Vetëm pronari mund të përdorë asistentin e detyrave.` | 403 | `profiles.role` nuk është `owner` |
| `Asnjë ofrues AI nuk është konfiguruar…` | 503 | Mungojnë `GROQ_API_KEY` dhe `OPENAI_API_KEY` te Secrets — shto `GROQ_API_KEY` |
| `Kredia e ofruesit AI ka mbaruar. Përdor një çelës falas (Groq) ose shto kredi.` | 429 | Kuota/kredia e ofruesit ka mbaruar (`insufficient_quota` / `no credits` / `429`) — vendos `GROQ_API_KEY` ose shto kredi |
| `serveri nuk u përgjigj brenda 90 sekondash` / `rrjeti dështoi` | — | Lidhje e dobët mobile — provo përsëri me Wi‑Fi |
| `Nuk u identifikua një kërkesë e vlefshme në audio.` | 422 | Audio shumë e qetë ose bosh — fol më afër mikrofonit |
| `Dërgo një skedar audio të vlefshëm.` | 400 | Regjistrimi s’u krijua si audio — provo një browser tjetër |

## Privatësia dhe kufijtë

Teksti, audioja (vetëm kur nuk ka transkriptim live), data dhe emrat e kontakteve të dukshme për pronarin dërgohen te ofruesi AI aktiv për përpunim. Audioja nuk ruhet nga kodi ynë; zbatohen veçmas politikat e ofruesve. Maksimumi 10 MB kërkesë dhe 6000 karaktere tekst; `Cache-Control: no-store`; mesazhet teknike të papërpunuara dhe çelësat e ofruesit nuk kthehen kurrë në browser.

## Testimi

Kërkohet Node.js 22.13+ (testet e endpoint-it përdorin heqjen e tipeve TypeScript të Node, pa varësi shtesë):

```sh
TZ=Europe/Tirane node --test tests/*.test.cjs
```
