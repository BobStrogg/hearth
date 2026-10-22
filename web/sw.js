"use strict";
// Hearth service worker: shows Web Push notifications and opens the session when one is tapped. No fetch handler
// (nothing is cached; the app always loads fresh from the server).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  const opts = { body: String(d.body || ""), tag: d.tag || undefined, renotify: !!d.tag, icon: "icon.svg", badge: "icon.svg", data: { url: d.url || "./" } };
  e.waitUntil(self.registration.showNotification(String(d.title || "Hearth"), opts));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue;
      await w.focus();
      if ("navigate" in w) { try { await w.navigate(url); } catch { /* cross-document navigate not allowed: focus is enough */ } }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
