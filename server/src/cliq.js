// Posts messages to a Zoho Cliq channel via an Incoming Webhook URL.
// If CLIQ_WEBHOOK_URL isn't set, runs in PREVIEW mode (prints to the console).

export function cliqEnabled() {
  return !!process.env.CLIQ_WEBHOOK_URL
}

export async function postToCliq(text) {
  const url = process.env.CLIQ_WEBHOOK_URL
  if (!url) {
    console.log('\n──────── 💬 CLIQ PREVIEW (no CLIQ_WEBHOOK_URL) ────────')
    console.log(text)
    console.log('───────────────────────────────────────────────────────\n')
    return { sent: false, mode: 'preview' }
  }
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000), // a hung provider must not leave this waiting ~5 min
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }), // Zoho Cliq incoming webhook expects { text }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Cliq webhook ${res.status}: ${body.slice(0, 200)}`)
  }
  return { sent: true, mode: 'cliq' }
}
