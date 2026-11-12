// Server-side speech-to-text with automatic language detection.
// Primary provider: Sarvam AI (saarika) — built for Telugu/Hindi/English + code-mixing.
// Also supports OpenAI / Groq Whisper. Node 18+ provides global fetch/FormData/Blob.

// opts.prompt = recent transcript text used as context so the model keeps names
// and spelling consistent across consecutive live segments (auto-correction).
// opts.provider overrides TRANSCRIPTION_PROVIDER for this one call. Used so long
// pre-recorded file uploads can go to OpenAI Whisper (no duration limit) even when
// the live recorder is set to Sarvam (whose instant endpoint caps audio at 30s).
export async function transcribeAudio(buffer, filename = 'audio.webm', mimetype = 'audio/webm', opts = {}) {
  const provider = (opts.provider || process.env.TRANSCRIPTION_PROVIDER || 'none').toLowerCase()
  if (provider === 'none') {
    const err = new Error('No transcription provider configured. Set TRANSCRIPTION_PROVIDER in server/.env (e.g. "sarvam") and the matching API key.')
    err.code = 'NO_PROVIDER'
    throw err
  }
  if (provider === 'sarvam') {
    try {
      return await sarvam(buffer, filename, mimetype)
    } catch (err) {
      // Sarvam's instant endpoint hard-fails past 30s: "Audio duration exceeds the
      // maximum limit of 30 seconds." Callers chunk below that, but a slow phone,
      // a container that over-runs its timeslice, or a caller that does not chunk
      // at all can still hand over a longer clip — and losing what someone just
      // said is the worst possible outcome.
      //
      // So Sarvam stays the primary engine and this is only a rescue: retry the
      // SAME audio on Whisper, which has no duration cap. If no Whisper key is
      // configured the original Sarvam error is rethrown unchanged, so the cause
      // is never hidden behind a fallback.
      const tooLong = /duration exceeds|maximum limit of 30|longer audio/i.test(err.message || '')
      const rescue = process.env.OPENAI_API_KEY ? 'openai' : (process.env.GROQ_API_KEY ? 'groq' : null)
      if (!tooLong || !rescue) throw err
      console.warn(`[transcribe] clip exceeded Sarvam's 30s limit — retrying on ${rescue}`)
      return whisper(buffer, filename, mimetype, rescue, opts)
    }
  }
  if (provider === 'openai' || provider === 'groq') return whisper(buffer, filename, mimetype, provider, opts)
  throw new Error(`Unknown TRANSCRIPTION_PROVIDER "${provider}"`)
}

// Sarvam AI — https://docs.sarvam.ai (Speech-to-Text). language_code "unknown" => auto-detect.
async function sarvam(buffer, filename, mimetype) {
  const key = process.env.SARVAM_API_KEY
  if (!key) throw new Error('SARVAM_API_KEY is not set in server/.env')
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimetype }), filename)
  form.append('model', process.env.SARVAM_MODEL || 'saarika:v2.5')
  // Lock the recognized language so audio is never mis-transcribed into other
  // Indian languages (Malayalam/Tamil/…). Default English; override per deployment
  // with SARVAM_LANGUAGE (e.g. te-IN, hi-IN). "unknown" re-enables full auto-detect.
  form.append('language_code', process.env.SARVAM_LANGUAGE || 'en-IN')
  const res = await fetch('https://api.sarvam.ai/speech-to-text', {
    signal: AbortSignal.timeout(180000), // a hung provider must not leave this waiting ~5 min
    method: 'POST',
    headers: { 'api-subscription-key': key },
    body: form,
  })
  if (!res.ok) throw new Error(`Sarvam ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  return { text: data.transcript || '', language: data.language_code || null }
}

// OpenAI (gpt-4o-transcribe by default — more accurate than whisper-1) or Groq
// (whisper-large-v3). Both auto-detect language. opts.prompt biases the model
// with prior context so names/terms stay consistent across live segments.
async function whisper(buffer, filename, mimetype, provider, opts = {}) {
  const isGroq = provider === 'groq'
  const key = isGroq ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY
  if (!key) throw new Error(`${isGroq ? 'GROQ_API_KEY' : 'OPENAI_API_KEY'} is not set in server/.env`)
  const base = isGroq ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1'
  const model = isGroq
    ? (process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3')
    : (process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe')
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimetype }), filename)
  form.append('model', model)
  form.append('response_format', 'json')
  // Context prompt (≤ ~224 tokens) keeps spelling/names consistent chunk-to-chunk.
  if (opts.prompt) form.append('prompt', String(opts.prompt).slice(-450))
  const res = await fetch(`${base}/audio/transcriptions`, {
    signal: AbortSignal.timeout(180000), // a hung provider must not leave this waiting ~5 min
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
  })
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  return { text: data.text || '', language: data.language || null }
}
