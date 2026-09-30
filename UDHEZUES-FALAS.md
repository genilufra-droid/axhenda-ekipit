# Axhenda Online — Udhëzues për versionin FALAS ☁️

Ky aplikacion (`index.html`) punon në dy mënyra:

- **Offline (demo):** hapet dhe punon menjëherë, të dhënat ruhen vetëm në atë browser.
- **Online (i përbashkët):** kur lidhet me **Supabase**, të gjithë punonjësit që përdorin **të njëjtin Kod ekipi** shohin të njëjtat detyra, mesazhe e skedarë — **në kohë reale**. SMS-të dërgohen përmes **textbee** (falas, me telefonin tënd Android).

> ⚠️ **Shënim:** versioni online kërkon internet dhe librari nga interneti. Prandaj **nuk** funksionon brenda parapamjes së aplikacionit — **shkarko `index.html`** dhe hape në një browser normal (ose vendose në Netlify/GitHub Pages).

---

## Pjesa 1 — Të dhëna të përbashkëta me Supabase (falas, pa kartë)

1. Shko te **https://supabase.com** → **Start your project** → regjistrohu (falas).
2. **New project** → jepi një emër dhe një fjalëkalim databaze → **Create**.
3. Prit ~1 minutë të krijohet. Pastaj hap **SQL Editor** → **New query**.
4. Kopjo gjithë përmbajtjen e skedarit **`supabase-setup.sql`** → **Run**. (Krijon tabelën + realtime.)
5. Shko te **Project Settings → API** dhe merr:
   - **Project URL** → p.sh. `https://abcd1234.supabase.co`
   - **anon public key** → një varg i gjatë që fillon me `eyJ...`
6. Hap `index.html` në browser → kliko butonin **☁️** lart djathtas → vendos:
   - **Supabase URL** = Project URL
   - **Supabase anon key** = anon public key
   - **Kodi i ekipit** = çfarëdo teksti, p.sh. `ekipi-im-2026` (i njëjti për të gjithë!)
   - **Lidhu** → treguesi bëhet **Online ✓**.
7. Jepu punonjësve **të njëjtin `index.html` + të njëjtin Kod ekipi** (dhe të njëjtat çelësa Supabase). Që tani ndajnë gjithçka.

**Të dhënat falas:** ~500 MB databazë + realtime. Mjafton për një ekip të vogël. (Projekti "fle" pas ~1 jave pa aktivitet — rikthehet me një klik nga paneli i Supabase.)

---

## Pjesa 2 — SMS reale FALAS me textbee (telefon Android)

textbee e kthen një telefon Android në një "portë SMS": SMS-të dërgohen me **SIM-in tënd** (deri **300 SMS/muaj falas**).

1. Merr një telefon Android (mund të jetë një i vjetër, i lidhur me karikues + internet).
2. Shko te **https://textbee.dev** → regjistrohu (pa kartë).
3. Shkarko aplikacionin nga **textbee.dev/download** dhe instaloje në telefon.
4. Në telefon: hap aplikacionin, **jep lejet e SMS-ve**.
5. Në web dashboard: **Register device / Generate API key** → **skano QR-in** me telefonin.
6. Kopjo **API Key**.
7. Hap `index.html` → paneli **📤 Dërgo SMS** → **⚙️ SMS me textbee** → ngjit **API Key** → **Ruaj**.
8. Provo: shkruaj një numër `+355...` (ose `069...` — shndërrohet vetë në `+355...`) dhe mesazhin → **Dërgo SMS**.

> Telefoni duhet të jetë **i ndezur, me aplikacionin hapur dhe me internet**.

### Nëse browser-i e bllokon (CORS)
Disa browser-a e bllokojnë thirrjen direkte. Zgjidhja falas: krijo një **Edge Function** në Supabase që dërgon SMS-në (fsheh edhe API Key-in):

```js
// supabase/functions/sms/index.ts  (Deno)
Deno.serve(async (req) => {
  const { recipients, message } = await req.json();
  const r = await fetch("https://api.textbee.dev/api/v1/gateway/send-sms", {
    method: "POST",
    headers: { "x-api-key": Deno.env.get("TEXTBEE_KEY")!, "Content-Type": "application/json" },
    body: JSON.stringify({ recipients, message }),
  });
  return new Response(await r.text(), {
    status: r.status,
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
  });
});
```

Deploy me: `supabase functions deploy sms --no-verify-jwt` dhe vendos sekretin `TEXTBEE_KEY`.
Pastaj te ⚙️ vendos **Proxy URL** = `https://<projekti>.supabase.co/functions/v1/sms`.

---

## Përmbledhje e kostos

| Pjesa | Shërbimi | Kosto |
|---|---|---|
| Të dhëna + realtime + login | Supabase | **0 €** (falas, pa kartë) |
| Hosting i `index.html` | Netlify / GitHub Pages | **0 €** |
| SMS reale te +355 | textbee + SIM-i yt | **0 €** (deri 300/muaj) |
| Njoftime alternative | Telegram Bot | **0 €** (pa limit) |

Gjithçka pa pagesë. Kur ekipi rritet, mund të kalosh në plane me pagesë pa ndryshuar aplikacionin.
