// Daily metrics cards for the team that already posts its numbers in the 132cr
// group, so they start on the card instead of each setting one up. Each card is
// the message that person was posting by hand (November 2026), word for word
// apart from spelling, with ___ where they type a number each day. {month} is
// filled in by the app; {date} is picked on the form. Each person can edit
// theirs from the card's sheet afterwards.
//
// Runs at every boot until each card is made, because the group and the names
// can only be found on the live database: a person not found yet (not in the
// group, a name spelt differently) is retried next boot and logged. Once a
// card is made it is marked in app_meta and never made again, so someone who
// stops their card does not get it back on the next deploy. A card made by the
// earlier seed (a list of numbers the app added up) is replaced by the text.
import { db } from './db.js'
import { id, now } from './util.js'
import { zonedNow } from './taskMail.js'

const TITLE = 'Daily metrics'

// `who`: ways to find the person among the group's members, tried in order;
// each is a list of pieces their name (lowercase, spaces removed) must hold.
// The first that matches exactly one member is used.
const CARDS = [
  { key: 'lohith', who: [['lohith'], ['lohit']], body: [
    'Lohith',
    'Leads for Dcal B2C = ___',
    'Leads for Dcal B2B = ___',
    'Leads for Rice B2B = ___',
    'Leads for Rice B2C = ___',
    'Website leads befach.com = ___',
  ] },
  { key: 'yaseen', who: [['yaseen'], ['yasin'], ['yas']], body: [
    'Yaseen',
    'Dcal',
    'Yaseen sales target for {month} (3 Lakhs-6 Lakhs) = ___/___',
    '1. Sales through dealers (pcs) = ___',
    '2. # of reviews received = ___',
    '3. Junk leads = ___',
  ] },
  { key: 'vinay', who: [['vinay']], body: [
    'Vinay',
    '___ Dcal Team Sales (25L) = ___/___',
    'No. of +ve reviews (100) received = ___/___',
    '',
    'Vinay',
    '1. # Sales target for ___ (20L) = ___/___',
    '2. # of connected leads from CRM = ___',
    '3. # of +ve reviews received = ___/___',
    'Junk leads = ___',
  ] },
  { key: 'sujitha', who: [['sujitha'], ['suji']], body: [
    'SUJITHA',
    'Rice',
    '1. Sales {month} (6-18 lacs) = ___/___',
    '2. # of +ve reviews received = ___/___',
    '3. Connected calls from CRM = ___',
    '4. Connected leads from CRM = ___',
    '5. Junk leads = ___',
  ] },
  { key: 'vijayteja', who: [['vijay', 'teja'], ['vijayteja'], ['vijay']], body: [
    '📊 *DAILY IMPORTS SALES REPORT*',
    '📅 Date: {date}',
    '',
    '*RFQs Generated:* ___ ({date})',
    '• Month-to-Date (MTD): ___ leads until {date}',
    '',
    '*Customers in Discussion with Suppliers*',
    '• Yesterday: ___',
    '• Month-to-Date (MTD): ___',
    '',
    '*Sales Performance*',
    '• Today: ₹___ ({date})',
    '• Month-to-Date (MTD): ₹___',
    'Reviews received so far: ___',
    'Sample orders received so far: ___',
  ] },
]

// They post in the morning; a reminder late morning, Monday to Saturday,
// reaches whoever has not. Each can change it on their card.
const REMIND_AT = '11:00'
const REMIND_DAYS = '1,2,3,4,5,6'

const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')

export function seedUpdateCards() {
  const marker = (k) => `seed_daily_metrics_132cr:${k}`
  const done = (k) => !!db.prepare('SELECT 1 FROM app_meta WHERE key=?').get(marker(k))
  const todo = CARDS.filter((c) => !done(c.key))
  if (!todo.length) return
  const groups = db.prepare("SELECT id, org_id, name FROM chat_conversations WHERE type='group'").all()
    .filter((g) => squash(g.name).includes('132cr'))
  if (groups.length !== 1) {
    console.log(`  [update-cards] 132cr group: ${groups.length ? `${groups.length} match (${groups.map((g) => g.name).join(', ')})` : 'not found'}, cards not made yet`)
    return
  }
  const g = groups[0]
  const members = db.prepare('SELECT u.id, u.name FROM chat_participants p JOIN users u ON u.id = p.user_id WHERE p.conversation_id = ?').all(g.id)
  const ts = now()
  for (const c of todo) {
    let hit = null
    for (const pieces of c.who) {
      const found = members.filter((u) => pieces.every((p) => squash(u.name).includes(p)))
      if (found.length === 1) { hit = found[0]; break }
    }
    if (!hit) { console.log(`  [update-cards] ${c.key}: no single member of "${g.name}" matches, not made yet`); continue }
    const body = c.body.join('\n')
    const has = db.prepare('SELECT id FROM daily_update_templates WHERE user_id=? AND conversation_id=?').get(hit.id, g.id)
    if (has) {
      // The earlier seed's card: same reminder, now their own message.
      db.prepare('UPDATE daily_update_templates SET title=?, body=?, updated_at=? WHERE id=?').run(TITLE, body, ts, has.id)
      console.log(`  [update-cards] replaced the card for ${hit.name} in ${g.name} with their message`)
    } else if (db.prepare('SELECT 1 FROM app_meta WHERE key=?').get(`seed_update_card_132cr:${c.key}`)) {
      // Made by the earlier seed and since stopped by them: stays stopped.
    } else {
      // Counted as reminded today: a deploy after 11:00 must not set every
      // phone in the group buzzing about a card nobody has seen yet.
      db.prepare(`INSERT INTO daily_update_templates (id, org_id, user_id, conversation_id, title, metrics, body, remind_at, remind_days, last_reminded_date, created_at, updated_at)
        VALUES (?,?,?,?,?,'[]',?,?,?,?,?,?)`).run(id('dut'), g.org_id, hit.id, g.id, TITLE, body, REMIND_AT, REMIND_DAYS, zonedNow().date, ts, ts)
      console.log(`  [update-cards] made "${TITLE}" for ${hit.name} in ${g.name}`)
    }
    db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(marker(c.key), ts)
  }
}
