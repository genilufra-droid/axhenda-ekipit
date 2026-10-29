# Axhenda e ekipit

Aplikacioni statik për detyrat, chat-in dhe lidhjen Cloud me Supabase.

Skedarët e faqes: `index.html`, `task-assistant.js` (analiza lokale e detyrës) dhe `voice-dictation.js` (motori i diktimit me zbulim të heshtjes 3-sekondëshe). Të tre duhet të jenë në të njëjtën dosje.

## GitHub Pages

1. Krijo një repository publik në GitHub.
2. Ngarko `index.html`, `task-assistant.js` dhe `voice-dictation.js` në degën `main`.
3. Hyr te **Settings → Pages**.
4. Te **Build and deployment**, zgjidh **Deploy from a branch**.
5. Zgjidh degën `main`, folderin `/ (root)`, pastaj **Save**.
6. Hape adresën që jep GitHub, zakonisht:
   `https://EMRI-YT.github.io/EMRI-REPOSITORY/`

## Asistenti AI

Përgatit detyra nga teksti ose zëri, me kontroll manual përpara ruajtjes dhe përpunim lokal kur AI nuk përgjigjet. Aktivizimi dhe privatësia: [udhëzuesi i asistentit](supabase/functions/transcribe-task/README.md).

Teste: `TZ=Europe/Tirane node --test tests/*.test.cjs`.

## Diktimi me zë (asistenti)

- **Telefon (Android/iOS) dhe pajisje me prekje:** kur të dyja janë të disponueshme,
  `MediaRecorder` nis i pari dhe `SpeechRecognition` nis 200 ms më pas. Teksti live
  është parapamje; kur serveri është i disponueshëm, audioja e plotë dërgohet për
  transkriptimin final. Përndryshe përdoret përpunimi lokal i tekstit live.
- **Kompjuter:** përdoret `SpeechRecognition` për tekst live; nëse sesioni i njohjes
  ndërpritet/riniset (ose dështon), audioja e plotë dërgohet në server. Pa server,
  teksti live mbetet si fallback për përpunimin lokal.
- **Kompozuesi:** fjalët live shfaqen te fusha e titullit pas tekstit ekzistues, pa
  hapur tastierën. Transkriptimi i serverit zëvendëson parapamjen; anulimi rikthen
  tekstin që ishte në fushë para diktimit. Drafti kërkon gjithmonë konfirmim.
- **Ndërprerjet:** `flushInterim()` ruan fjalët e papërfunduara kur browseri e mbyll
  sesionin pa `isFinal`. Rinisja është e menjëhershme, me 150 ms pushim vetëm pas më
  shumë se tre rinisjeve brenda dy sekondave.
- **Njohës i pamundur:** gabimet `language-not-supported`, `not-allowed`,
  `service-not-allowed` dhe `audio-capture` nuk rinisin njohësin (mikrofoni nuk i
  hiqet regjistruesit pa fund); paneli e thotë qartë dhe audioja e plotë mbetet burimi.
  Për `language-not-supported` shkruhet shprehimisht se ky browser nuk njeh shqipen
  për tekst live.
- **Statusi:** derisa `getUserMedia`, `MediaRecorder` (state `recording`) dhe VAD-i me
  `AudioContext` të jenë gati, paneli shfaq “Po hap mikrofonin… prit një çast” dhe nuk
  shënohet si “Po dëgjoj…”.

## Saktësia e diktimit

Diktimi nuk premton 100% saktësi: njohja varet nga browseri, mikrofoni, zhurma dhe
modeli i telefonit. Ai që kontrollohet nga aplikacioni:

- **Parapamja live (`#tTitle`)** lexohet nga `VoiceDictation.readResults()`: të gjitha
  hipotezat e papërfunduara, jo vetëm indeksi që browseri raporton në `resultIndex`.
  Më parë gjysma e fjalisë fshihej kur fillonte një indeks i re dhe parapamja dukej se
  “riniste në mes të fjalisë”.
- **Bashkimi i fjalëve** (`mergeTranscript`) nuk shkruan dy herë të njëjtën fjalë kur
  njohësi e përsërit: shkronjat e mëdha, shenjat e pikësimit, `ë/ç` e shtypur pa
  shenja dhe trajtat e ndryshme të së njëjtës fjalë (`faturat` / `faturën`,
  `përgatit` / `përgatisë`) njihen si e njëjta fjalë në kryqëzimin e dy pjesëve.
  Fjalë të ndryshme kurrë nuk bashkohen (`shumë` ≠ `shumicën`) dhe teksti që u
  shkrua nuk rishkruhet.
- **Rezultati final i njohësit** zëvendëson parapamjen e varur; një frazë e
  finalizuar nuk numërohet dy herë, edhe pse `start()` i një sesioni të ri i
  numëron rezultatet nga zero.
- **Transkripti final i serverit** mbetet burimi autoritativ për draftin; parapamja
  live ruhet vetëm si fallback lokal kur serveri dështon ose nuk kthen tekst.
  Prefiksi i shkruar më parë, anulimi, fokusi/kursori, aksesueshmëria dhe
  konfirmimi manual para ruajtjes nuk ndryshojnë; tastiera nuk hapet gjatë diktimit.

### Si të raportohet një gabim saktësie

Shtyp **“Kopjo detajet”** nën statusin e asistentit pas një dështimi: aty shkruhen
pajisja/browseri, parapamja live me numrin e fjalëve, transkripti final, dallimi
`live/final` (sa fjalë u hoqën / u shtuan), gabimi i njohësit, numri i rinisjeve dhe
nëse browseri mat zërin. Për një diagnozë të plotë nevojiten edhe: modeli i telefonit,
browseri dhe një shembull “çfarë thashë / çfarë u shkrua”.
