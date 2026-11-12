// Embedding provider for the RAG layer.
// Turns text into vectors so we can rank org data by semantic similarity to a
// question. Provider-agnostic: OpenAI by default, Voyage (Anthropic's recommended
// embeddings partner) when VOYAGE_API_KEY is set. Mirrors the key-or-fallback
// philosophy of claude.js / openai.js — if no embedding key is configured,
// hasEmbeddings() is false and the assistant simply keeps using its existing
// "dump the snapshot" path instead of RAG.
import crypto from 'node:crypto'

const OPENAI_URL = 'https://api.openai.com/v1/embeddings'
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings'

// OpenAI text-embedding-3-small = 1536 dims, ~$0.02 / 1M tokens.
const OPENAI_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small'
const VOYAGE_MODEL = process.env.VOYAGE_EMBED_MODEL || 'voyage-3'

// Voyage wins if its key is present (better retrieval); else OpenAI.
function provider() {
  if (process.env.VOYAGE_API_KEY) return 'voyage'
  if (process.env.OPENAI_API_KEY) return 'openai'
  return null
}

export const hasEmbeddings = () => provider() !== null
export const embedModel = () => (provider() === 'voyage' ? VOYAGE_MODEL : OPENAI_MODEL)

// Stable hash of a chunk's text, so we can skip re-embedding unchanged content.
export const hashText = (text) => crypto.createHash('sha1').update(text).digest('hex')

// Float32 vector <-> BLOB for SQLite storage.
export const toBlob = (vec) => Buffer.from(new Float32Array(vec).buffer)
export const fromBlob = (buf) =>
  new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)

// Cosine similarity between two equal-length vectors (Float32Array or number[]).
export function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// Embed an array of strings -> array of Float32Array (same order).
// Batches into one API call. Throws if no provider is configured or the call fails.
export async function embedTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return []
  const p = provider()
  if (!p) throw new Error('No embedding provider configured (set OPENAI_API_KEY or VOYAGE_API_KEY)')
  // Guard against empty strings — providers reject them.
  const input = texts.map((t) => (t && t.trim()) || ' ')

  if (p === 'voyage') {
    const res = await fetch(VOYAGE_URL, {
      signal: AbortSignal.timeout(30000), // a hung provider must not leave this waiting ~5 min
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
      body: JSON.stringify({ model: VOYAGE_MODEL, input }),
    })
    if (!res.ok) throw new Error(`Voyage ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    return (data.data || []).map((d) => Float32Array.from(d.embedding))
  }

  const res = await fetch(OPENAI_URL, {

    signal: AbortSignal.timeout(30000), // a hung provider must not leave this waiting ~5 min
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, input }),
  })
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  // OpenAI returns results indexed; sort by .index to be safe.
  return (data.data || [])
    .slice()
    .sort((x, y) => (x.index ?? 0) - (y.index ?? 0))
    .map((d) => Float32Array.from(d.embedding))
}

// Convenience: embed a single string -> one Float32Array.
export async function embedQuery(text) {
  const [vec] = await embedTexts([text])
  return vec
}
