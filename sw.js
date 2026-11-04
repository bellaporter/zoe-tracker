// Shows Zoe's reminder alerts sent from the server.
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function(e){
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch(_) {}
  e.waitUntil(self.registration.showNotification(d.title || "Zoe's Tracker", {
    body: d.body || '',
    tag: d.tag || 'zoe',
    icon: 'icon-192.png',
    badge: 'icon-192.png'
  }));
});
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(ws){
    for (var i = 0; i < ws.length; i++) { if ('focus' in ws[i]) return ws[i].focus(); }
    return self.clients.openWindow('./');
  }));
});
