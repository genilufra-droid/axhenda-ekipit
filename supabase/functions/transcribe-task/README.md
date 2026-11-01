# `transcribe-task` dhe `assistant-speak`

Dy Supabase Edge Functions të vogla që punojnë vetëm për Pronarin e identifikuar:

- **`transcribe-task`** — merr audion (`audio`) dhe/ose tekstin live (`liveTranscript`), datën (`today`), fjalorin (`vocabulary`) dhe draftin aktual (`currentDraft`). Kombinon në paralel **3 motorë të njohjes së gjuhës shqipe**:
  1. **Whisper Large v3 (`language=sq`, `temperature=0`)** në Groq për transkriptim akustik të shqipes + emrave të ekipit,
  2. **Google Web Speech (`sq-AL`)** nga browseri (`liveTranscript`, me 5 alternativa N-best),
  3. **Google Gemini Multimodal Audio (`gemini-3.6-flash` low-thinking → `gemini-3-flash-preview` → `gemini-3.5-flash-lite`)** që dëgjon direkt audion origjinale dhe verifikon çdo rrokje, shkronjat `ë`/`ç` dhe lakimet e emrave të punonjësve (`profiles` + `punonjesit`), me rezervë automatike LLM në Groq (`openai/gpt-oss-120b` / `qwen/qwen3.8-27b`).
  Kthen `{ ok: true, transcript, draft: { title, description, assignee, due, priority } }`. Nuk ruan asnjë detyrë dhe nuk dërgon asnjë njoftim.
- **`assistant-speak`** — merr `{ text }` dhe kthen zërin në shqip nga **Gemini TTS** (`gemini-3.8-flash-lite-tts`, `gemini-3.8-flash-tts`, `gemini-3.1-flash-tts-preview`, `gemini-2.5-flash-preview-tts`): `{ ok: true, audioBase64, mimeType }`. Nëse ky shërbim mungon ose vonon, dritarja e asistentes kalon vetë në zërin shqip të telefonit ose vetëm në tekst.

## Sekretet në Supabase

```bash
supabase secrets set GEMINI_API_KEY="AIza..."
supabase secrets set GROQ_API_KEY="gsk_..."
```

Opsionale (vetëm nëse do të caktosh vetë modelin): `GEMINI_MODEL`, `GEMINI_TTS_MODEL`.

## Publikimi

```bash
supabase functions deploy transcribe-task --no-verify-jwt
supabase functions deploy assistant-speak --no-verify-jwt
```

Autentifikimi kontrollohet brenda funksioneve me `SUPABASE_SERVICE_ROLE_KEY` (`/auth/v1/user` + roli i pronarit te `public.profiles`).
