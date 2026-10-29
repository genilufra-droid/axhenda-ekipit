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
- **Statusi:** derisa `getUserMedia`, `MediaRecorder` (state `recording`) dhe VAD-i me
  `AudioContext` të jenë gati, paneli shfaq “Po hap mikrofonin… prit një çast” dhe nuk
  shënohet si “Po dëgjoj…”.
