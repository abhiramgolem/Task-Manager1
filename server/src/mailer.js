// Email sender. If SMTP_* env vars are configured it sends via nodemailer;
// otherwise it runs in PREVIEW mode and prints the email to the server console.
import nodemailer from 'nodemailer'

let transporter = null
let mode = 'preview'

function init() {
  if (transporter !== null || mode === 'smtp') return
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // nodemailer's defaults wait up to 10 minutes on a stuck mail server, and
      // the scheduler's tick waits with it.
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    })
    mode = 'smtp'
  }
}

export function mailerMode() {
  init()
  return mode
}

export async function sendMail({ to, subject, text, html }) {
  init()
  if (mode === 'smtp' && transporter) {
    const from = process.env.MAIL_FROM || process.env.SMTP_USER
    await transporter.sendMail({ from, to, subject, text, html })
    return { sent: true, mode: 'smtp' }
  }
  // Preview mode — log so it's testable without credentials.
  console.log('\n──────── ✉  EMAIL PREVIEW (no SMTP configured) ────────')
  console.log(`To:      ${to}`)
  console.log(`Subject: ${subject}`)
  console.log(text || '(html only)')
  console.log('───────────────────────────────────────────────────────\n')
  return { sent: false, mode: 'preview' }
}
