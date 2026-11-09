// VoTask's service worker, for browser notifications only (src/lib/webPush.ts,
// server/src/webPush.js). It caches nothing: the site loads exactly as it
// would without it.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch (_) {}
  e.waitUntil((async () => {
    // VoTask open and in front of you: the page already shows it (the unread
    // counts, the bell's chime). A system notification on top would say the
    // same thing twice.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (wins.some((w) => w.focused && w.visibilityState === 'visible')) return
    await self.registration.showNotification(d.title || 'VoTask', {
      body: d.body || '',
      // One per chat, as on the phone: a new message replaces that chat's
      // notification, and renotify makes it sound again.
      tag: d.tag || undefined,
      renotify: !!d.tag,
      icon: '/logo.png',
      badge: '/favicon.png',
      data: { url: d.url || '/' },
    })
  })())
})

// A click opens the chat or task it is about: in the VoTask tab already open,
// moved there inside the app, or in a new tab.
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const path = (e.notification.data && e.notification.data.url) || '/'
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin)
    if (win) {
      await win.focus()
      win.postMessage({ type: 'votask-open', url: path })
      return
    }
    await self.clients.openWindow(new URL(path, self.location.origin).href)
  })())
})
