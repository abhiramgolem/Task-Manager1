// "A new version of VoTask is available — Update / Later", as other apps ask.
// Google Play decides whether this install has a newer build waiting
// (AppUpdatePlugin.java, In-App Updates), so the prompt appears once a release
// is live on the Play Store for this user, and Update runs Play's own update
// screen, which downloads, installs and restarts the app.
//
// Checked when the app opens and when it comes back to the screen (at most
// hourly). "Later" holds that version's prompt off for a day. A no-op on the
// website, on builds without the plugin, and on a sideloaded build, which Play
// does not offer updates to.
import { Capacitor, registerPlugin } from '@capacitor/core'
import { confirmDialog } from './confirm'

interface UpdateInfo { available?: boolean; inProgress?: boolean; versionCode?: number; staleDays?: number; priority?: number; error?: string }
interface AppUpdatePlugin {
  check(): Promise<UpdateInfo>
  update(): Promise<{ started?: boolean; store?: boolean; result?: number }>
}

const AppUpdate = registerPlugin<AppUpdatePlugin>('AppUpdate')

const CHECK_EVERY_MS = 60 * 60 * 1000
const LATER_MS = 24 * 60 * 60 * 1000
const LATER_KEY = 'appUpdateLater' // { v: versionCode, at: ms }

let started = false
let lastCheck = 0
let asking = false

function snoozed(v: number) {
  try {
    const s = JSON.parse(localStorage.getItem(LATER_KEY) || 'null')
    return s && s.v === v && Date.now() - s.at < LATER_MS
  } catch { return false }
}

async function checkNow() {
  if (asking || Date.now() - lastCheck < CHECK_EVERY_MS) return
  lastCheck = Date.now()
  let info: UpdateInfo
  try { info = await AppUpdate.check() } catch { return }
  // Left half-way through Play's update screen: carry straight on.
  if (info.inProgress) { AppUpdate.update().catch(() => {}); return }
  const v = info.versionCode || 0
  if (!info.available || snoozed(v)) return
  // Another question is already on screen; this one can wait for the next check.
  if (document.querySelector('.confirm-modal')) { lastCheck = 0; return }
  asking = true
  try {
    const yes = await confirmDialog({
      title: 'Update available',
      message: 'A new version of VoTask is ready, with the latest features and fixes. Update now?',
      confirmText: 'Update',
      cancelText: 'Later',
    })
    if (yes) await AppUpdate.update().catch(() => {})
    else localStorage.setItem(LATER_KEY, JSON.stringify({ v, at: Date.now() }))
  } finally {
    asking = false
  }
}

/** Play's update screen now (a tapped "update available" notification). */
export function openUpdate() {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('AppUpdate')) return
  AppUpdate.update().catch(() => {})
}

/** Starts watching for updates. Once, at app start. */
export function startUpdateCheck() {
  if (started || !Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('AppUpdate')) return
  started = true
  // A moment after launch, so the prompt is not the first thing to paint.
  setTimeout(checkNow, 3000)
  import('@capacitor/app').then(({ App }) => {
    App.addListener('appStateChange', ({ isActive }) => { if (isActive) checkNow() })
  }).catch(() => {})
}
