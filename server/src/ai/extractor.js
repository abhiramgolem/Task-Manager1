// Orchestrator: choose Claude when configured, else the rule-based engine.
// Then resolve spoken names to real user records and return a unified result.
import { analyzeTranscript, detectLanguages } from './rules.js'
import { finishFromStretches, liveAnalysisEnabled } from './liveAnalysis.js'
import { attachEvidence } from './evidence.js'
import { analyzeWithClaude } from './claude.js'
import { analyzeWithOpenAI } from './openai.js'
import { analyzeWithOpenRouter } from './openrouter.js'
import { db } from '../db.js'

// Match a spoken/raw name to a user in the org via name, alias, or token match.
// Matching is WHOLE-WORD, not loose substring — so "an" never matches "Ananya"
// and a spoken sentence only assigns when it actually contains the person's name.
//
// resolveUserInfo also reports WHICH tier matched. Tiers 1-3 are ordinary speech
// (full name, saved alias, first name); tiers 4-5 are genuine fuzz (a stray token,
// a prefix) — the alias-learning loop in routes/assistant.js records those and, if
// the action stands, saves the spoken form as an alias so the same mishear resolves
// at tier 2 forever after.
export function resolveUserInfo(orgId, rawName) {
  if (!rawName) return { user: null, tier: 0 }
  const users = db.prepare('SELECT * FROM users WHERE org_id = ?').all(orgId)
  const norm = (s) => (s || '').toLowerCase().trim()
  const target = norm(rawName)
  if (!target) return { user: null, tier: 0 }
  const tokens = (s) => norm(s).split(/\s+/).filter(Boolean)
  const targetTokens = tokens(target)

  // 1. Exact full name.
  let hit = users.find((u) => norm(u.name) === target)
  if (hit) return { user: hit, tier: 1 }
  // 2. Alias list (comma-separated), exact match on a whole alias.
  hit = users.find((u) => (u.aliases || '').split(',').map(norm).filter(Boolean).includes(target))
  if (hit) return { user: hit, tier: 2 }
  // 3. First name exactly equals what was spoken ("Ravi" -> "Ravi Kumar").
  hit = users.find((u) => tokens(u.name)[0] === target)
  if (hit) return { user: hit, tier: 3 }
  // 4. Any name token exactly matches a spoken token (≥ 2 chars) — handles a
  //    surname or a phrase that contains the person's name.
  hit = users.find((u) => tokens(u.name).some((nt) => nt.length >= 2 && targetTokens.includes(nt)))
  if (hit) return { user: hit, tier: 4 }
  // 5. Last resort: a clear prefix match on the first name (spoken "Reddep" for
  //    "Reddeppa"), only for fragments ≥ 4 chars to avoid false hits.
  if (target.length >= 4) {
    hit = users.find((u) => {
      const first = tokens(u.name)[0] || ''
      return first && (first.startsWith(target) || target.startsWith(first))
    })
    if (hit) return { user: hit, tier: 5 }
  }
  return { user: null, tier: 0 }
}

export function resolveUser(orgId, rawName) {
  return resolveUserInfo(orgId, rawName).user
}

// Small-string Levenshtein for near-miss name detection — inputs are single
// spoken tokens, so the quadratic cost is irrelevant.
function editDistance(a, b) {
  const m = a.length, n = b.length
  const row = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[n]
}

// What did the user actually CALL this person? The agent often normalizes a
// misheard name silently (its prompt carries the team list), so by the time an
// action arrives the canonical name is in the args and the mishear only survives
// in the transcript. If none of the person's real name tokens appear there, hunt
// for a near-miss of the first name — same first letter, edit distance 1 (2 for
// longer names) — and return it as the spoken form worth learning as an alias.
// Returns null when the name was said correctly or nothing plausible is found.
export function findSpokenAlias(transcript, userRow) {
  const nameTokens = String(userRow.name || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!nameTokens.length) return null
  const words = String(transcript || '').toLowerCase().match(/[\p{L}0-9]+/gu) || []
  const known = (userRow.aliases || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)
  if (words.some((w) => known.includes(w))) return null        // already resolving via an alias
  // Per token, not per name: "Rabi Kumar" gets the surname right and the first
  // name wrong, and the wrong half is exactly the part worth learning.
  for (const nt of nameTokens) {
    if (words.includes(nt)) continue                           // this token was said right
    const near = words.find((w) =>
      w.length >= 3 && !nameTokens.includes(w)
      && w[0] === nt[0] && Math.abs(w.length - nt.length) <= 2
      && editDistance(w, nt) <= (nt.length > 5 ? 2 : 1))
    if (near) return near
  }
  return null
}

// Resolve a spoken name to a user, restricted to a set of allowed user IDs
// (the meeting attendees). The AI must never assign work to a non-attendee.
export function resolveUserAmong(orgId, rawName, allowedIds) {
  const u = resolveUser(orgId, rawName)
  if (!u) return null
  if (allowedIds && allowedIds.length && !allowedIds.includes(u.id)) return null
  return u
}

export async function analyzeMeetingTranscript(transcript, opts = {}) {
  // Engine priority: OpenRouter (primary) → Claude → OpenAI/GPT → offline rules.
  // Each tier is tried only if its key is set, falling through on error.
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY
  const hasClaude = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI = !!process.env.OPENAI_API_KEY

  if (hasOpenRouter) {
    try { return cite(await analyzeWithOpenRouter(transcript, opts), transcript) }
    catch (err) { console.warn('[ai] OpenRouter failed:', err.message) }
  }
  if (hasClaude) {
    try { return cite(await analyzeWithClaude(transcript, opts), transcript) }
    catch (err) { console.warn('[ai] Claude failed:', err.message) }
  }
  if (hasOpenAI) {
    try { return cite(await analyzeWithOpenAI(transcript, opts), transcript) }
    catch (err) {
      console.warn('[ai] OpenAI failed, falling back to rule-based:', err.message)
      const result = analyzeTranscript(transcript, opts)
      result.fallback_reason = err.message
      return cite(result, transcript)
    }
  }
  return cite(analyzeTranscript(transcript, opts), transcript)
}

// A meeting recorded with live analysis on arrives with the stretches analysed
// while it was going on (ai/liveAnalysis.js). Only what they do not cover is read
// now. If none of them is still in the transcript, or finishing fails for any
// reason, the whole transcript is analysed exactly as it would have been without
// them — the stretches can make this faster, never make it fail.
export async function analyzeMeetingTranscriptLive(transcript, stretches, opts = {}) {
  if (stretches?.length && liveAnalysisEnabled()) {
    try {
      const result = await finishFromStretches(transcript, stretches, opts)
      if (result) {
        if (!result.detected_languages.length) result.detected_languages = detectLanguages(transcript)
        return cite(result, transcript)
      }
    } catch (err) {
      console.warn('[ai] live analysis could not finish, analysing the whole transcript:', err.message)
    }
  }
  return analyzeMeetingTranscript(transcript, opts)
}

// Every return path goes through this, so a summary point can always be
// traced back to the sentence behind it no matter which engine produced it —
// and no model prompt has to be taught about citations.
function cite(result, transcript) {
  try { return attachEvidence(result, transcript) }
  catch (err) { console.warn('[ai] evidence linking failed:', err.message); return result }
}
