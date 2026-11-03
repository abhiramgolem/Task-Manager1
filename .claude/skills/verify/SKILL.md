---
name: verify
description: Build, run and drive the SmartTask app (React client + Express server) to observe a change working end-to-end.
---

# Verifying SmartTask

Two processes, each in its own terminal:

```bash
cd server && npm run dev     # Express + SQLite, port 4000
cd client && npm run dev     # Vite, port 5173 (falls back to 5174 if taken)
```

`EADDRINUSE` on 4000 means a stale node process:
`Get-NetTCPConnection -LocalPort 4000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`

Note the port Vite actually printed — it silently moves to 5174.

## Getting past the login wall

Most of the app is behind `Layout`, so you need a token. Don't log in as a
real user or write to the DB — mint a token instead. The client reads it from
`localStorage['smarttask_token']`; the secret is `JWT_SECRET` in `server/.env`.

```js
// run from server/ as an .mjs file, then delete the file
import { db } from './src/db.js'
import jwt from 'jsonwebtoken'
const u = db.prepare('SELECT id,name,role,org_id FROM users LIMIT 1').get()
console.log(jwt.sign({ sub: u.id, role: u.role, org_id: u.org_id, name: u.name },
  process.env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: '2h' }))
```

`server/data/app.db` holds REAL org data. Read from it; never write.

## Driving a browser

No Playwright in the repo. Install `playwright-core` into the scratchpad and
point it at the system Chrome — don't add a dep to the project:

```js
chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
// context: { viewport: {width:430,height:900}, permissions:['microphone'] }
```

The 430x900 viewport gets you the mobile layout (bottom nav, AI orb); wider
gets the desktop sidebar. Both are worth a look for UI changes.

## Voice features

Voice is the app's core surface and can't be driven with a real microphone
headlessly. Inject fakes via `context.addInitScript` **before** the app boots:

- **Wake word in speech mode** (`client/src/voice/wakeSpeech.ts`): stub
  `window.SpeechRecognition` with a class whose `start()` stashes `this` on
  `window.__sr`, then push synthetic transcripts by calling `onresult` with
  `{resultIndex:0, results:{0:{0:{transcript},length:1,isFinal:true},length:1}}`.
  Assistant opened == a `.va-panel` or `.va-mini` element exists.
- **Wake word in onnx mode** (`client/src/voice/wakeword.ts`): needs real audio;
  not drivable headlessly. Verify only that it does/doesn't load the models
  (watch for `.onnx` / `ort-wasm` network requests).
- Set `VITE_WAKEWORD_DEBUG=true` in `client/.env` — the detectors log what they
  hear/score to the console.
- The recorder path (`voice/recorder.ts`) posts to `/api/tasks/transcribe`;
  a fake media device produces silence, so it'll take the no-speech branch.

## Gotchas

- The repo is inside OneDrive, which can silently revert uncommitted edits.
  Commit as soon as a change verifies.
- `VoiceAssistant` remounts on every route change, so anything it starts
  (wake-word session, ONNX load) tears down and re-inits on navigation.
