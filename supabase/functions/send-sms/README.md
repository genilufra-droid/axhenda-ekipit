# 📬 Edge Function: `send-sms` (Twilio)

Kjo Edge Function dërgon SMS përmes [Twilio](https://www.twilio.com/) dhe përdoret nga aplikacioni
**Axhenda e Ekipit** kur pronari ka konfiguruar një *SMS API URL* te **⚙️ Cilësimet SMS**.

Nëse SMS API **nuk** është konfiguruar, aplikacioni përdor `sms:` URI (hap aplikacionin SMS të telefonit) si rezervë.

---

## 🇦🇱 Udhëzime deployimi (Shqip)

### 1. Instalo Supabase CLI
```bash
npm install -g supabase
# ose: brew install supabase/tap/supabase
```

### 2. Hyr në llogari dhe lidh projektin
```bash
supabase login
supabase link --project-ref ruwxxypntyhxdwegkmkl
```
> Zëvendëso `project-ref` me referencën e projektit tënd (gjendet te Supabase Dashboard → Settings → General).

### 3. Krijo një llogari Twilio dhe merr kredencialet
- Regjistrohu te https://www.twilio.com/
- Nga **Twilio Console** merr:
  - `Account SID`
  - `Auth Token`
  - Një numër dërgues (`From`) të aktivizuar për SMS (p.sh. `+1XXXXXXXXXX`).

### 4. Vendos secrets (çelësat) në Supabase
```bash
supabase secrets set TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxx
supabase secrets set TWILIO_AUTH_TOKEN=your_auth_token
supabase secrets set TWILIO_FROM_NUMBER=+1XXXXXXXXXX
```

### 5. Deploy funksionin
```bash
supabase functions deploy send-sms
```

### 6. Merr URL-në e funksionit
URL-ja do të jetë e formës:
```
https://<PROJECT_REF>.supabase.co/functions/v1/send-sms
```
Kopjoje këtë URL dhe vendose te **👥 Punonjësit → ⚙️ Cilësimet SMS → URL e SMS API**, pastaj kliko **Ruaj**.

### 7. Testo
```bash
curl -X POST 'https://<PROJECT_REF>.supabase.co/functions/v1/send-sms' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <SUPABASE_ANON_KEY>' \
  -d '{"to":"+3556XXXXXXXX","message":"Përshëndetje nga Axhenda e Ekipit!"}'
```
Përgjigjja e suksesshme:
```json
{ "success": true, "sid": "SMxxxxxxxx" }
```

---

## 🇬🇧 Deployment instructions (English)

### 1. Install the Supabase CLI
```bash
npm install -g supabase
```

### 2. Log in and link your project
```bash
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>
```

### 3. Create a Twilio account and grab the credentials
From the Twilio Console copy your `Account SID`, `Auth Token`, and an SMS-enabled `From` number.

### 4. Set the secrets
```bash
supabase secrets set TWILIO_ACCOUNT_SID=ACxxxxxxxx
supabase secrets set TWILIO_AUTH_TOKEN=your_auth_token
supabase secrets set TWILIO_FROM_NUMBER=+1XXXXXXXXXX
```

### 5. Deploy
```bash
supabase functions deploy send-sms
```

### 6. Use the URL
Paste `https://<PROJECT_REF>.supabase.co/functions/v1/send-sms` into the app's
**Employees → ⚙️ SMS Settings → SMS API URL** field and click Save.

---

## 📥 Request / Response

**Request** `POST` JSON body:
```json
{ "to": "+3556XXXXXXXX", "message": "Teksti i SMS-it" }
```

**Response (sukses):**
```json
{ "success": true, "sid": "SMxxxxxxxx" }
```

**Response (gabim):**
```json
{ "error": "Përshkrimi i gabimit" }
```

## 🔐 Shënime / Notes
- Secrets nuk ruhen kurrë në kod apo në bazën e të dhënave — vetëm si Supabase secrets.
- Funksioni ka CORS të hapur (`*`) që të thirret nga aplikacioni web (GitHub Pages).
- Twilio tarifon për çdo SMS të dërguar sipas çmimores së tyre.
