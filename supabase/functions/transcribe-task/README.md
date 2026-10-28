# Asistenti i detyrave (tekst + audio)

Funksioni `transcribe-task` transkripton audio në shqip dhe kthen një **propozim** detyre. Nuk ruan detyra, nuk dërgon njoftime dhe nuk ruan skedarë audio në Storage. Ndryshimet ruhen vetëm pas konfirmimit në ndërfaqe.

## Aktivizimi

1. Projekti duhet të ketë Supabase Auth dhe tabelën ekzistuese `public.profiles` me `id`, `role`, `display_name`. Pronari duhet të ketë `role = 'owner'`. Mbaj RLS aktive; funksioni lexon profilet me token-in e përdoruesit dhe nuk përdor service-role key.
2. Vendos `OPENAI_API_KEY` te **Edge Functions → Secrets**. Mos e vendos në HTML, Git ose localStorage. Sigurohu që llogaria e ofruesit ka kuotë/faturim aktiv. Opsionale: `OPENAI_TASK_MODEL` (parazgjedhje `gpt-4o-mini`, duhet të mbështesë JSON Schema).
3. Publiko funksionin nga kjo dosje/repository:

   ```sh
   supabase functions deploy transcribe-task --project-ref ID_E_PROJEKTIT
   ```

   Mos përdor `--no-verify-jwt`. Përveç verifikimit në gateway, funksioni verifikon përdoruesin në Auth dhe rolin në databazë. Për projektet me konfigurim të ri të gateway/çelësave, ndiq konfigurimin e përshtatshëm të platformës pa hequr kontrollet e Auth dhe rolit në kod.
4. Publiko **edhe `task-assistant.js` dhe `voice-dictation.js` pranë `index.html`**. Hap aplikacionin me HTTPS për mikrofonin.

`SUPABASE_URL` dhe `SUPABASE_ANON_KEY` ofrohen nga mjedisi i funksioneve. Nuk kërkohet migrim i ri i databazës. Ky ndryshim në repository nuk e publikon vetë funksionin dhe nuk vendos secrets.

## Sjellja

- Tekst: shkruaj p.sh. “Cakto Arben Kola të përgatisë raportin nesër, urgjent” dhe shtyp **✨ AI**.
- Audio: shtyp **një herë** mikrofonin dhe fol. Teksti shfaqet drejtpërdrejt në panelin “Po dëgjoj…”. Regjistrimi ndalon vetë kur mikrofonit i mungon **zë real për 3 sekonda të plota** (matet me RMS nga Web Audio API, jo nga mungesa e rezultateve të SpeechRecognition). Çdo fjalë e re e rifillon numërimin; pauzat e shkurtra dhe zëri i ulët nuk e ndërpresin. Kufiri i një diktimi është 60 sekonda; një klikim i dytë ndalon menjëherë.
- Pas ndalimit hapet automatikisht dritarja **“Konfirmo dërgimin”** me titull, përshkrim/transkriptim, punonjës, afat dhe prioritet. Asgjë nuk ruhet dhe asnjë SMS/Email nuk dërgohet pa shtypur **“Konfirmo dhe dërgo”**; **“Anulo”** nuk ruan dhe nuk njofton. Njoftimi është zgjedhje e veçantë brenda kësaj dritareje dhe nuk trashëgohet nga shiriti i kompozimit.
- Pa zë ose me transkriptim bosh dritarja e konfirmimit **nuk hapet**.
- Nëse browser-i nuk ofron transkriptim të drejtpërdrejtë (p.sh. disa versione iOS/Safari ose Chrome me shërbim të bllokuar), paneli e thotë qartë dhe audioja transkriptohet në server pas ndalimit — nuk pretendohet transkriptim live.
- **Escape** (ose butoni “Anulo” në panel) anulon regjistrimin/kërkesën ose mbyll propozimin. Mikrofoni dhe `AudioContext` lirohen gjithmonë: pas ndalimit, gabimit, anulimit dhe largimit nga faqja.
- Nëse shërbimi nuk është konfiguruar ose dështon, teksti/transkriptimi i browser-it analizohet lokalisht. Kjo shënohet qartë; nuk pretendohet se është përgjigje nga AI. Në browser pa transkriptim lokal, dështimi i serverit kërkon shkrim manual.
- Njohja lokale mbulon sot/nesër/pasnesër, pas N ditësh/javësh, ditët e javës, YYYY-MM-DD dhe DD.MM.YYYY / DD/MM/YYYY. Përdor data kalendarike lokale; një ditë jave e njëjtë me sot do të thotë java tjetër.
- Punonjësit e propozuar nga AI kontrollohen kundrejt kontakteve. Datat e pamundura refuzohen. Emrat e panjohur/afatet e paqarta kërkojnë kontroll manual.
- Njoftimet në Chat/SMS/Email janë zgjedhje më vete, jo të aktivizuara detyrimisht. Funksioni ekzistues `notify-task` duhet të jetë aktiv për dërgimin e tyre; ai nuk përfshihet në këtë ndryshim.

## Kur shfaqet “Audioja nuk u transkriptua: …”

Që nga ky version, arsyeja e vërtetë shfaqet në ekran dhe detajet teknike shfaqen nën të me butonin **“Kopjo detajet”**. Përputhja e shkurtër:

| Arsyeja në ekran | Shkaku | Zgjidhja |
|---|---|---|
| `funksioni transcribe-task nuk është publikuar (404)` | Funksioni nuk është deployuar në projekt | `supabase functions deploy transcribe-task --project-ref <REF>` |
| `Sesioni ka skaduar. Hyr përsëri.` | Token i skaduar | Hyr sërish në aplikacion |
| `Vetëm pronari mund të përdorë asistentin e detyrave.` | `profiles.role` nuk është `owner` | Kontrollo rreshtin e profilit tënd |
| `AI nuk është konfiguruar…` | Mungon `OPENAI_API_KEY` te Secrets | Vendose sekretin dhe riprovo |
| `AI është i ngarkuar…` | Kuota/limiti i ofruesit | Prit dhe provo përsëri |
| `koha mbaroi (90 s)` / `rrjeti dështoi` | Lidhje e dobët mobile | Provo përsëri me Wi‑Fi |
| `Nuk u identifikua një kërkesë e vlefshme në audio.` | Audio shumë e qetë ose bosh | Fol më afër mikrofonit |
| `Dërgo një skedar audio të vlefshëm.` | Regjistrimi s’u krijua si audio | Provo një browser tjetër |

Nëse browser-i nuk ofron transkriptim të drejtpërdrejtë, transkriptimi varet **vetëm** nga ky funksion; prandaj deploy-i i tij është i detyrueshëm për telefonat që nuk kanë SpeechRecognition.

## Privatësia dhe kufijtë

Teksti, audioja (nëse regjistrohet), data dhe emrat e kontakteve të dukshme për pronarin dërgohen te ofruesi AI për përpunim. Njohja zanore e browser-it mund të përdorë shërbimin e tij të jashtëm. Audioja nuk ruhet nga kodi ynë; zbatohen veçmas politikat e ruajtjes së ofruesve. Për përpunim vetëm lokal, mos aktivizo funksionin cloud (njohja zanore e browser-it mund të mbetet shërbim i jashtëm).

Maksimumi 10 MB kërkesë dhe 6000 karaktere tekst; kufij kohorë në browser dhe në thirrjet e jashtme. Mesazhet teknike/çelësat e ofruesit nuk dërgohen në browser. Për përdorim me volum, vendos kuotë shpenzimi në ofrues dhe rate limiting në gateway; ky funksion kontrollon rolin por nuk implementon kuotë të qëndrueshme për përdorues.

## Testimi

Kërkohet Node.js 22.13+ (testet e endpoint-it përdorin heqjen e tipeve TypeScript të Node, pa varësi shtesë). Thirrjet e jashtme dhe ndërfaqja simulohen në teste.

```sh
TZ=Europe/Tirane node --test tests/*.test.cjs
```

Për verifikim manual pas publikimit:

- si pronar: tekst, audio, anulim me Escape, ndalim manual, afat i pavlefshëm, titull bosh;
- diktim i vetëm me një shtypje: teksti duhet të shfaqet gjatë të folurit, të ndalet vetë pas 3 sekondash heshtjeje dhe të rifillojë numërimin kur flet përsëri;
- provo në telefon (Android Chrome dhe iPhone Safari) me ekran të ndezur dhe me telefonatë/zë të ulët;
- blloko lejen e mikrofonit; provo pa lidhje dhe pa funksion AI;
- kontrollo që anulimi nuk ndryshon formularin dhe që një konfirmim shton vetëm një detyrë;
- provo si punonjës dhe me token të skaduar: endpoint-i duhet të refuzojë;
- kontrollo ikonën e mikrofonit të browser-it pas mbylljes së regjistrimit;
- testet lokale nuk bëjnë thirrje reale te ofruesi dhe nuk vërtetojnë konfigurimin e prodhimit.
