// Express 4 never looks at what a route handler returns. An `async` handler
// that throws produces a rejected promise nobody catches: the request gets no
// answer at all (the phone spins until it times out) and crashLog.js logs an
// unhandled rejection. Several routes were like that (invite, join approval,
// user admin, MCP). Rather than wrap each by hand and miss the next one, every
// handler's returned promise is caught here and passed to next(err), which the
// error middleware in index.js answers with a proper error. This is the same
// patch the `express-async-errors` package applies; Express 5 does it natively.
import Layer from 'express/lib/router/layer.js'

const handle = Layer.prototype.handle_request
if (!handle.__asyncSafe) {
  const patched = function (req, res, next) {
    const fn = this.handle
    if (fn.length > 3) return next() // an error handler; not for this path
    try {
      const out = fn(req, res, next)
      if (out && typeof out.catch === 'function') out.catch((err) => next(err || new Error('Request failed')))
    } catch (err) {
      next(err)
    }
  }
  patched.__asyncSafe = true
  Layer.prototype.handle_request = patched
}
