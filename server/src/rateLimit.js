// A small in-memory rate limiter for the routes anyone can call without being
// signed in: login, signup, password reset, join requests.
//
// Two reasons. Guessing passwords should be slow. And each attempt costs a
// bcrypt hash (~100-250 ms of CPU on the starter plan's half core), so a script
// hammering /login made the server unresponsive for everyone else.
//
// In memory is enough: there is one process (render.yaml), and a restart only
// forgets the counts. Keys are pruned every minute, so memory stays bounded.

const buckets = new Map() // key -> { n, reset }
const MAX_KEYS = 50_000

setInterval(() => {
  const t = Date.now()
  for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k)
}, 60_000).unref()

// `key(req)` names who is being counted (null = don't count this request).
// Only POSTs count — a GET of the login page is not an attempt.
export function rateLimit({ name, windowMs, max, key, message }) {
  return (req, res, next) => {
    if (req.method !== 'POST') return next()
    const k = key(req)
    if (!k) return next()
    const id = `${name}:${k}`
    const t = Date.now()
    let b = buckets.get(id)
    if (!b || t > b.reset) {
      if (buckets.size >= MAX_KEYS) return next() // never grow without bound; fail open
      b = { n: 0, reset: t + windowMs }
      buckets.set(id, b)
    }
    if (++b.n > max) {
      res.set('Retry-After', String(Math.ceil((b.reset - t) / 1000)))
      return res.status(429).json({ error: message || 'Too many attempts. Please wait a minute and try again.' })
    }
    next()
  }
}
