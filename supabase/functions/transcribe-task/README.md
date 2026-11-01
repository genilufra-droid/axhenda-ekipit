# transcribe-task and assistant-speak (Gemini + Groq backup)

Two Supabase Edge Functions for the Axhenda voice assistant. Both accept only a signed-in **owner** (`profiles.role` = `owner`/`pronar`).

## transcribe-task
Multipart request: `audio` (optional, max 10 MB), `liveTranscript` (optional text), `today` (YYYY-MM-DD), `vocabulary`, `currentDraft` (JSON).
Response: `{ ok, transcript, draft: { title, description, assignee, due, priority } }`.
Names not in the staff list and impossible dates are dropped; priority is `Ulet`, `Mesme` or `Lart`.
Models: `GEMINI_MODEL` (optional secret), then `gemini-3.5-flash-lite`, `gemini-flash-lite-latest`, and `gemini-3.1-flash-lite`, with automatic fallback to Groq (`whisper-large-v3-turbo` + `llama-3.3-70b-versatile`) when `GROQ_API_KEY` is configured. The function only prepares a draft; saving and notifying stay with the owner in the app.

## assistant-speak
JSON request `{ "text": "..." }` (cut at 600 characters). Response `{ ok, audioBase64, mimeType }` (raw PCM, 24 kHz).
Models: `GEMINI_TTS_MODEL` (optional secret), then `gemini-3.8-flash-lite-tts`, `gemini-3.8-flash-tts`, `gemini-3.1-flash-tts-preview`, and `gemini-2.5-flash-preview-tts`, voice Kore.
If it fails, the app falls back to the browser voice, then to text only.

## Secrets (Supabase → Edge Functions → Secrets)
`GEMINI_API_KEY` (required; `GROQ_API_KEY` optional backup). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase. Never put keys in HTML or Git.

## Errors
Short Albanian messages only (401 sign in again, 403 owner only, 400 nothing heard, 413 audio too long, 429 free limit, 502 AI failed). Provider details stay in the function logs.

## Deploy
`supabase functions deploy transcribe-task assistant-speak --no-verify-jwt --project-ref ruwxxypntyhxdwegkmkl`
