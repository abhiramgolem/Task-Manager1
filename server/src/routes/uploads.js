import { Router } from 'express'
import { authRequired } from '../auth.js'
import { openUpload, receiveChunk, cancelUpload } from '../fileStore.js'

// A big file sent in chunks (see "Chunked uploads" in fileStore.js). Nothing
// here knows about chats or tasks: the upload ends by calling the route the
// file was meant for — POST /chat/conversations/:id/upload or
// POST /tasks/:id/attachments — with { uploadId }, and that route decides
// whether this person may put it there, exactly as it does for multipart.
const r = Router()
r.use(authRequired)

r.post('/', (req, res) => {
  const got = openUpload(req.user, req.body || {})
  if (got.error) return res.status(got.status).json({ error: got.error })
  res.status(201).json(got.upload)
})

r.put('/:id', receiveChunk)

r.delete('/:id', (req, res) => {
  cancelUpload(req.user, req.params.id)
  res.json({ ok: true })
})

export default r
