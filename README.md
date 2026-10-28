# Axhenda e ekipit

Aplikacioni statik për detyrat, chat-in dhe lidhjen Cloud me Supabase.

## GitHub Pages

1. Krijo një repository publik në GitHub.
2. Ngarko `index.html` dhe `task-assistant.js` në degën `main`.
3. Hyr te **Settings → Pages**.
4. Te **Build and deployment**, zgjidh **Deploy from a branch**.
5. Zgjidh degën `main`, folderin `/ (root)`, pastaj **Save**.
6. Hape adresën që jep GitHub, zakonisht:
   `https://EMRI-YT.github.io/EMRI-REPOSITORY/`

## Asistenti AI

Përgatit detyra nga teksti ose zëri, me kontroll manual përpara ruajtjes dhe përpunim lokal kur AI nuk përgjigjet. Aktivizimi dhe privatësia: [udhëzuesi i asistentit](supabase/functions/transcribe-task/README.md).

Teste: `TZ=Europe/Tirane node --test tests/*.test.cjs`.
