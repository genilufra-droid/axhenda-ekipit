# transcribe-task and assistant-speak (Gemini)

Two Supabase Edge Functions for the Axhenda voice assistant. Both accept only a signed-in **owner** (`profiles.role` = `owner`/`pronar`).

## transcribe-task
Multipart request: `audio` (optional, max 10 MB), `liveTranscript` (optional text), `today` (YYYY-MM-DD), `vocabulary`, `currentDraft` (JSON).
Response: `{ ok, transcript, draft: { title, description, assignee, due, priority } }`.
Names not in the staff list and impossible dates are dropped; priority is `Ulet`, `Mesme` or `Lart`.
Models: `GEMINI_MODEL` (optional secret), then `gemini-2.5-flash` and `gemini-flash-latest`. The function only prepares a draft; saving and notifying stay with the owner in the app.

## assistant-speak
JSON request `{ "text": "..." }` (cut at 600 characters). Response `{ ok, audioBase64, mimeType }` (raw PCM, 24 kHz).
Models: `GEMINI_TTS_MODEL` (optional secret), then `gemini-2.5-flash-preview-tts` and `gemini-2.5-pro-preview-tts`, voice Kore.
If it fails, the app falls back to the browser voice, then to text only.

## Secrets (Supabase → Edge Functions → Secrets)
`GEMINI_API_KEY` (required). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase. Never put keys in HTML or Git.
`GROQ_API_KEY` and `OPENAI_API_KEY` are no longer used.

## Errors
Short Albanian messages only (401 sign in again, 403 owner only, 400 nothing heard, 413 audio too long, 429 free limit, 502 AI failed). Provider details stay in the function logs.

## Deploy
`supabase functions deploy transcribe-task assistant-speak --project-ref ruwxxypntyhxdwegkmkl`
