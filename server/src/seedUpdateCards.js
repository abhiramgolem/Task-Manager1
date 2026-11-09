// Daily update cards for the team that already posts its numbers in the 132cr
// group, so they start on the card instead of each setting one up. Built from
// the messages they were posting by hand (November 2026); each person can edit
// theirs from the card's sheet afterwards.
//
// Runs at every boot until each card is made, because the group and the names
// can only be found on the live database: a person not found yet (not in the
// group, a name spelt differently) is retried next boot and logged. Once a
// card is made it is marked in app_meta and never made again, so someone who
// stops their card does not get it back on the next deploy.
import { db } from './db.js'
import { id, now } from './util.js'
import { zonedNow } from './taskMail.js'

const daily = (mid, label, extra = {}) => ({ id: mid, label, target: null, stretch: null, unit: '', mode: 'daily', ...extra })
const rupees = { unit: '₹' }

// `who`: ways to find the person among the group's members, tried in order;
// each is a list of pieces their name (lowercase, spaces removed) must hold.
// The first that matches exactly one member is used.
const CARDS = [
  { key: 'sujitha', who: [['sujitha'], ['suji']], title: 'Sales update', metrics: [
    daily('sales', 'Sales', { ...rupees, target: 600000, stretch: 1800000 }),
    daily('reviews', 'Positive reviews received'),
    daily('calls', 'Connected calls from CRM'),
    daily('leads', 'Connected leads'),
    daily('junk', 'Junk leads'),
  ] },
  { key: 'yaseen', who: [['yaseen'], ['yasin'], ['yas']], title: 'Sales update', metrics: [
    daily('sales', 'Sales', { ...rupees, target: 300000, stretch: 600000 }),
    daily('dealers', 'Sales through dealers', { unit: 'pcs' }),
    daily('reviews', 'Reviews received'),
    daily('junk', 'Junk leads'),
  ] },
  { key: 'vinay', who: [['vinay']], title: 'Sales update', metrics: [
    daily('team', 'Dcal team sales', { ...rupees, target: 2500000 }),
    daily('teamrev', 'Team positive reviews', { target: 100 }),
    daily('sales', 'My sales', { ...rupees, target: 2000000 }),
    daily('leads', 'Connected leads from CRM'),
    daily('reviews', 'Positive reviews received'),
    daily('junk', 'Junk leads'),
  ] },
  { key: 'lohith', who: [['lohith'], ['lohit']], title: 'Leads update', metrics: [
    daily('dcalb2c', 'Leads: Dcal B2C'),
    daily('dcalb2b', 'Leads: Dcal B2B'),
    daily('riceb2b', 'Leads: Rice B2B'),
    daily('riceb2c', 'Leads: Rice B2C'),
    daily('web', 'Website leads (befach.com)'),
  ] },
  { key: 'vijayteja', who: [['vijay', 'teja'], ['vijayteja'], ['vijay']], title: 'Daily imports sales report', metrics: [
    daily('rfq', 'RFQs generated'),
    daily('disc', 'Customers in discussion with suppliers'),
    daily('sales', 'Sales', rupees),
  ] },
]

// They post in the morning; a reminder late morning, Monday to Saturday,
// reaches whoever has not. Each can change it on their card.
const REMIND_AT = '11:00'
const REMIND_DAYS = '1,2,3,4,5,6'

const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')

export function seedUpdateCards() {
  const marker = (k) => `seed_update_card_132cr:${k}`
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
    const has = db.prepare('SELECT 1 FROM daily_update_templates WHERE user_id=? AND conversation_id=?').get(hit.id, g.id)
    if (!has) {
      // Counted as reminded today: a deploy after 11:00 must not set every
      // phone in the group buzzing about a card nobody has seen yet.
      db.prepare(`INSERT INTO daily_update_templates (id, org_id, user_id, conversation_id, title, metrics, remind_at, remind_days, last_reminded_date, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id('dut'), g.org_id, hit.id, g.id, c.title, JSON.stringify(c.metrics), REMIND_AT, REMIND_DAYS, zonedNow().date, ts, ts)
      console.log(`  [update-cards] made "${c.title}" for ${hit.name} in ${g.name}`)
    }
    db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(marker(c.key), ts)
  }
}
