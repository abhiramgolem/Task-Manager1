// Ties every line of a meeting summary back to the sentence that produced it.
//
// A summary a manager cannot check is a summary they have to take on trust, and
// the one question anyone actually asks of an AI summary is "where did that come
// from?". Suggested TASKS already carried a source_quote; the summary did not —
// rules.js built decisions and risks straight out of transcript sentences and
// then threw the sentence away with `.map(d => d.text)`.
//
// This runs AFTER whichever engine produced the analysis, so it works the same
// for the rule-based fallback and for every LLM tier, and needs no change to any
// model prompt. For the rule engine the summary line IS a transcript sentence,
// so the match is exact; for an LLM it is a paraphrase, so the match is the
// best-overlapping segment and the score says how sure that is.
import { parseSegments } from './rules.js'

// Words too common to carry meaning. Kept deliberately short: a long stop list
// starts throwing away the domain words ("order", "site") that make a match.
const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'have', 'has', 'had', 'will', 'would',
  'are', 'was', 'were', 'from', 'they', 'them', 'you', 'your', 'but', 'not', 'can',
  'all', 'our', 'their', 'there', 'then', 'than', 'been', 'being', 'into', 'about',
  'some', 'what', 'when', 'which', 'who', 'how', 'its', 'his', 'her', 'she', 'him',
])

const words = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .filter((w) => w.length > 2 && !STOP.has(w))

// Every segment's words, tokenised once per transcript, with the segments each
// word appears in. Scoring used to re-tokenise every segment for every point,
// which is points × segments: a five-hour meeting through the rule engine (4,500
// segments, a point per task) spent 52 s here, synchronously, with every other
// request on the server waiting behind it. Through the index a point only visits
// the segments that share a word with it.
function indexSegments(segments) {
  const prepared = segments.map((seg) => ({ seg, words: new Set(words(seg.text)), lower: String(seg.text).toLowerCase() }))
  const postings = new Map()
  const starts = []
  let at = 0
  prepared.forEach((p, i) => {
    for (const w of p.words) {
      const list = postings.get(w)
      if (list) list.push(i); else postings.set(w, [i])
    }
    starts.push(at)
    at += p.lower.length + 1
  })
  // All the lowered text in one string, so "which segment contains this point
  // verbatim" is one indexOf rather than one per segment. NUL separates them, so
  // a match can never straddle two.
  const hay = prepared.map((p) => p.lower).join('\u0000')
  return { prepared, postings, starts, hay }
}

// The first segment (that has any words at all) whose text contains `needle`.
function firstContaining({ prepared, starts, hay }, needle) {
  if (needle.includes('\u0000')) return prepared.findIndex((p) => p.words.size && p.lower.includes(needle))
  let from = 0
  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at < 0) return -1
    let lo = 0, hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= at) lo = mid; else hi = mid - 1
    }
    if (prepared[lo].words.size) return lo
    from = starts[lo] + prepared[lo].lower.length + 1
  }
}

function bestIn(point, index) {
  const wanted = new Set(words(point))
  if (!wanted.size) return null

  // A near-verbatim line (the rule engine's case) should always beat a merely
  // topical one, even when the segment carries a lot of other words.
  let best = firstContaining(index, String(point).toLowerCase().trim())
  let bestScore = best < 0 ? 0 : 1
  const hits = new Map()
  for (const w of wanted) for (const i of index.postings.get(w) || []) hits.set(i, (hits.get(i) || 0) + 1)
  for (const [i, n] of hits) {
    const score = n / wanted.size
    // Ties go to the earlier segment, as they did when segments were scanned in order.
    if (score > bestScore || (score === bestScore && i < best)) { bestScore = score; best = i }
  }

  // Below this it is a guess, and a wrong quote is worse than no quote — it
  // would have someone defending a decision against a sentence nobody said.
  if (best < 0 || bestScore < 0.34) return null
  const seg = index.prepared[best].seg
  return {
    quote: seg.text,
    speaker: seg.speaker,
    seq: seg.seq,
    language: seg.language || 'en',
    match: Math.round(bestScore * 100),
  }
}

/**
 * The transcript segment a summary point most likely came from, or null when
 * nothing matches well enough to be worth showing.
 *
 * Scored on how much of the POINT is accounted for by the segment, not the other
 * way round: a long segment that happens to contain the whole point is a good
 * source, while a short segment sharing one word with a long point is not.
 */
export function bestEvidence(point, segments) {
  return bestIn(point, indexSegments(segments))
}

// Summary sections that are lists of points worth citing. `executive_summary` is
// deliberately absent: it describes the whole meeting, so no single line is its
// source, and pointing at one would be a lie dressed as provenance.
const CITED = ['key_decisions', 'action_items', 'risks', 'blockers', 'follow_ups']

/**
 * Rewrite a summary's point lists from `string[]` to `{ text, evidence }[]`.
 *
 * Idempotent, and tolerant of an engine that already returned objects, so it is
 * safe to run over any tier's output. Old meetings stored as plain strings keep
 * working — the client normalises either shape.
 */
export function attachEvidence(analysis, transcript) {
  if (!analysis?.summary || !transcript) return analysis
  let segments = []
  try { segments = parseSegments(transcript) } catch { return analysis }
  if (!segments.length) return analysis

  const index = indexSegments(segments)
  for (const key of CITED) {
    const list = analysis.summary[key]
    if (!Array.isArray(list) || !list.length) continue
    analysis.summary[key] = list.map((item) => {
      const text = typeof item === 'string' ? item : (item?.text ?? '')
      if (item && typeof item === 'object' && item.evidence) return item   // already cited
      return { text, evidence: bestIn(text, index) }
    })
  }
  return analysis
}
