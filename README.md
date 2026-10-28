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

- **Telefon (Android/iOS) dhe pajisje me prekje:** mikrofoni ka vetëm një përdorues —
  `MediaRecorder`. `SpeechRecognition` nuk ndizet paralel, sepse në celular të dy
  konkurrojnë për mikrofonin dhe fjalët priten në mes. Kur je i loguar, audioja e plotë
  dërgohet te `transcribe-task` (Groq `whisper-large-v3-turbo`) dhe transkriptohet e saktë.
  Pa hyrje (offline) përdoret vetëm `SpeechRecognition`, përsëri pa regjistrim paralel.
- **Kompjuter:** përdoret `SpeechRecognition` për tekst live; nëse sesioni i njohjes
  ndërpritet/riniset (ose dështon), audioja e plotë dërgohet në server dhe teksti live
  mbetet vetëm si fallback lokal.
- **Papritur:** `flushInterim()` ruan fjalët e papërfunduara kur browseri e mbyll sesionin
  e njohjes pa `isFinal`, dhe rinisja bëhet menjëherë (pa vonesë 250 ms).
- **Statusi:** derisa `getUserMedia`, `MediaRecorder` (state `recording`) dhe VAD-i me
  `AudioContext` të jenë gati, paneli shfaq “Po hap mikrofonin… prit një çast” dhe nuk
  shënohet si “Po dëgjoj…”.
