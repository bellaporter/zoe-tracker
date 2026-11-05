// Connects the tracker page to Zoe's own API (Cloudflare) instead of Claude's storage.
// Provides window.claude.use('db' | 'assets') with the same small interface the page uses,
// plus sign-in, phone alerts, reminder scheduling and a one-time data import.
(function(){
  var API = (window.ZOE_API || '').replace(/\/+$/, '');
  var TOKEN_KEY = 'zoe_token';
  function getToken(){ try { return localStorage.getItem(TOKEN_KEY) || ''; } catch(e){ return ''; } }
  function setToken(t){ try { localStorage.setItem(TOKEN_KEY, t); } catch(e){} }
  function pad(n){ return n<10 ? '0'+n : ''+n; }
  function keyOf(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }

  var readyResolve; var ready = new Promise(function(r){ readyResolve = r; });

  function api(path, opts){
    opts = opts || {};
    opts.headers = Object.assign({ 'Authorization': 'Bearer ' + getToken() }, opts.headers || {});
    return fetch(API + path, opts).then(function(r){
      if(r.status === 401){ showLogin(); throw { code: 'auth' }; }
      if(!r.ok) throw { code: r.status === 413 ? 'too_large' : 'unavailable' };
      var ct = r.headers.get('content-type') || '';
      return ct.indexOf('json') >= 0 ? r.json() : r;
    }, function(){ throw { code: 'unavailable' }; });
  }
  window.photoUrl = function(id){ return API + '/api/photos/' + id + '?t=' + encodeURIComponent(getToken()); };

  // ---------- db shim ----------
  var pending = {}, lastSet = {}, collListeners = [];
  function snap(id, r){ return { id: id, exists: !!r.exists, data: function(){ return r.data; }, metadata: { hasPendingWrites: false, fromCache: false } }; }
  function docRef(path){
    var id = path.split('/').pop();
    return {
      id: id, path: path,
      get: function(){ return api('/api/' + path).then(function(r){ return snap(id, r); }); },
      set: function(data){
        pending[path] = (pending[path] || 0) + 1; lastSet[path] = Date.now();
        return api('/api/' + path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
          .then(function(){ afterSave(path, data); setTimeout(pollCollections, 300); })
          .finally(function(){ pending[path]--; });
      },
      onSnapshot: function(next, err){
        var alive = true, last = null;
        function tick(){
          if(!alive || document.hidden) return;
          if(pending[path] > 0 || Date.now() - (lastSet[path] || 0) < 4000) return;
          api('/api/' + path).then(function(r){
            if(!alive || pending[path] > 0 || Date.now() - (lastSet[path] || 0) < 4000) return;
            var s = JSON.stringify(r); if(s !== last){ last = s; next(snap(id, r)); }
          }).catch(function(){});
        }
        tick();
        var iv = setInterval(tick, 15000);
        function vis(){ if(!document.hidden) tick(); }
        document.addEventListener('visibilitychange', vis);
        return function(){ alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', vis); };
      }
    };
  }
  function pollCollections(){
    if(!collListeners.length) return;
    api('/api/days').then(function(r){
      var docs = (r.days || []).map(function(d){ return snap(d.date, { exists: true, data: d.data }); });
      collListeners.forEach(function(fn){ fn({ docs: docs, size: docs.length, empty: !docs.length, docChanges: function(){ return []; }, metadata: { hasPendingWrites: false, fromCache: false } }); });
    }).catch(function(){});
  }
  setInterval(function(){ if(!document.hidden) pollCollections(); }, 60000);
  function collection(name){
    var q = { orderBy: function(){ return q; }, limit: function(){ return q; }, where: function(){ return q; },
      onSnapshot: function(next){ collListeners.push(next); pollCollections(); return function(){ collListeners = collListeners.filter(function(f){ return f !== next; }); }; },
      doc: function(id){ return docRef(name + '/' + id); } };
    return q;
  }
  var dbShim = { doc: docRef, collection: collection };
  var assetsShim = {
    upload: function(blob, o){ return api('/api/photos', { method: 'POST', headers: { 'Content-Type': (o && o.type) || blob.type || 'image/jpeg' }, body: blob }).then(function(r){ return { id: r.id, url: window.photoUrl(r.id) }; }); },
    delete: function(id){ return api('/api/photos/' + id, { method: 'DELETE' }); }
  };
  window.claude = { use: function(name){
    if(!API) return Promise.resolve(null);
    if(name === 'db') return ready.then(function(){ return dbShim; });
    if(name === 'assets') return ready.then(function(){ return assetsShim; });
    return Promise.resolve(null);
  } };

  // ---------- reminders (sent as phone alerts by the server) ----------
  function fmt(hm){ var p = hm.split(':'), h = +p[0]; return (h%12 || 12) + ':' + p[1] + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function afterSave(path, data){
    var m = path.match(/^days\/(\d{4}-\d{2}-\d{2})$/);
    if(m && m[1] === keyOf(new Date())){
      var am = data.am || {};
      var tag = 'feed-' + m[1];
      if(am.entyce && am.entyceAt){
        var p = am.entyceAt.split(':'), d = new Date(); d.setHours(+p[0], +p[1], 0, 0);
        var at = d.getTime() + 30 * 60000;
        var fedAfter = (data.events || []).some(function(e){ return e.type === 'food' && e.items && Object.keys(e.items).length && e.time >= am.entyceAt; });
        if(fedAfter) api('/api/reminders/' + tag, { method: 'DELETE' }).catch(function(){});
        else if(at > Date.now()){
          api('/api/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: tag, at: at, title: 'Time to feed Zoe', body: 'Entyce was given at ' + fmt(am.entyceAt) + '. Offer her biggest meal now while she is hungriest.' }) }).catch(function(){});
        }
      } else api('/api/reminders/' + tag, { method: 'DELETE' }).catch(function(){});
    }
    if(path === 'settings/zoe' && data.packOpened){
      var o = data.packOpened.split('-'), last = new Date(+o[0], +o[1]-1, +o[2] + 3, 19, 0, 0);
      if(last.getTime() > Date.now())
        api('/api/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: 'pack', at: last.getTime(), title: "Zoe's food pack", body: 'Today is the last day for the open Farmer’s Dog pack. Throw out what is left tonight and move a new pack to the fridge to thaw.' }) }).catch(function(){});
    }
  }

  // ---------- sign-in ----------
  var loginEl = null;
  function showLogin(){
    if(loginEl) return;
    loginEl = document.createElement('div'); loginEl.className = 'zlogin';
    loginEl.innerHTML = '<div class="zbox"><img src="icon-192.png" alt=""><h1>Zoe’s Tracker</h1><p id="zmsg">Checking…</p>' +
      '<form id="zform" hidden><label for="zpass" id="zlabel">Passcode</label><input id="zpass" type="password" inputmode="numeric" autocomplete="current-password" minlength="4" required>' +
      '<button type="submit" id="zgo">Sign in</button><p class="zerr" id="zerr"></p></form></div>';
    document.body.appendChild(loginEl);
    if(!API){ document.getElementById('zmsg').textContent = 'Still setting up. Check back in a few minutes.'; return; }
    fetch(API + '/api/status').then(function(r){ return r.json(); }).then(function(s){
      var first = !s.setup;
      document.getElementById('zmsg').textContent = first ? 'Create a passcode. Anyone who logs Zoe’s care will use it.' : 'Enter the passcode to open Zoe’s log.';
      document.getElementById('zlabel').textContent = first ? 'New passcode (at least 4 characters)' : 'Passcode';
      document.getElementById('zgo').textContent = first ? 'Create passcode' : 'Sign in';
      var f = document.getElementById('zform'); f.hidden = false; document.getElementById('zpass').focus();
      f.onsubmit = function(ev){
        ev.preventDefault();
        var pass = document.getElementById('zpass').value;
        fetch(API + (first ? '/api/setup' : '/api/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: pass }) })
          .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
          .then(function(x){
            if(!x.ok){ document.getElementById('zerr').textContent = x.j.error === 'wrong' ? 'That passcode is not right. Try again.' : 'Could not sign in. Try again.'; return; }
            setToken(x.j.token); loginEl.remove(); loginEl = null; readyResolve(); location.reload();
          }).catch(function(){ document.getElementById('zerr').textContent = 'Could not reach the server. Check your connection.'; });
      };
    }).catch(function(){ document.getElementById('zmsg').textContent = 'Could not reach the server. Check your connection and reload.'; });
  }

  // ---------- phone alerts ----------
  function urlB64ToUint8(s){ s = s.replace(/-/g, '+').replace(/_/g, '/'); while(s.length % 4) s += '='; var b = atob(s), a = new Uint8Array(b.length); for(var i=0;i<b.length;i++) a[i] = b.charCodeAt(i); return a; }
  function alertsCard(){
    var wrap = document.querySelector('.wrap'); if(!wrap) return;
    var c = document.createElement('section'); c.className = 'card'; c.id = 'alertsCard';
    c.innerHTML = '<h2>Phone alerts</h2><p class="er" id="zaText"></p><div class="goaledit"><button type="button" class="allbtn" id="zaOn" style="padding:0 14px">Turn on alerts</button><button type="button" class="linkbtn" id="zaTest" hidden>Send a test alert</button></div>' +
      '<p class="er" style="margin-top:4px"><button type="button" class="linkbtn" id="zImportBtn">Import data</button><input type="file" id="zImport" accept="application/json" hidden> <span id="zImportMsg"></span></p>';
    wrap.appendChild(c);
    var txt = c.querySelector('#zaText'), on = c.querySelector('#zaOn'), test = c.querySelector('#zaTest');
    var standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    function state(){
      if(!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)){
        txt.textContent = standalone ? 'This phone does not support alerts from web apps. Update iOS to 16.4 or later.' : 'To get alerts, open this from the icon on your home screen (Share, then Add to Home Screen), then tap Turn on alerts.';
        on.hidden = true; return;
      }
      if(Notification.permission === 'granted'){ txt.textContent = 'Alerts are on for this phone: morning meds at 8:30 AM, night meds at 9 PM, a ping 30 minutes after Entyce, and the last day of a food pack.'; on.textContent = 'Refresh alerts'; test.hidden = false; }
      else if(Notification.permission === 'denied'){ txt.textContent = 'Alerts are blocked. Turn them on in iPhone Settings, Notifications, Zoe.'; on.hidden = true; }
      else txt.textContent = 'Get a ping when it is time to feed Zoe, even when your phone is locked.';
    }
    state();
    on.onclick = function(){
      Notification.requestPermission().then(function(p){
        if(p !== 'granted'){ state(); return; }
        return navigator.serviceWorker.register('sw.js').then(function(){ return navigator.serviceWorker.ready; }).then(function(reg){
          return fetch(API + '/api/push/key').then(function(r){ return r.json(); }).then(function(k){
            return reg.pushManager.getSubscription().then(function(s){ return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(k.key) }); });
          });
        }).then(function(sub){ return api('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) }); })
          .then(function(){ state(); txt.textContent = 'Alerts are on for this phone.'; })
          .catch(function(){ txt.textContent = 'Could not turn on alerts. Try again.'; });
      });
    };
    test.onclick = function(){ test.textContent = 'Sending…'; api('/api/push/test', { method: 'POST' }).then(function(r){ test.textContent = r.sent ? 'Test sent' : 'No phones signed up yet'; }).catch(function(){ test.textContent = 'Could not send'; }); };

    // one-time import of Zoe's data from the earlier tracker
    var imp = c.querySelector('#zImport'), msg = c.querySelector('#zImportMsg');
    c.querySelector('#zImportBtn').onclick = function(){ imp.click(); };
    imp.onchange = function(){
      var f = imp.files && imp.files[0]; if(!f) return;
      msg.textContent = 'Importing…';
      f.text().then(function(t){
        var d = JSON.parse(t), map = {};
        var photos = d.photos || [];
        return photos.reduce(function(p, ph){ return p.then(function(){
          var bin = atob(ph.b64), a = new Uint8Array(bin.length); for(var i=0;i<bin.length;i++) a[i] = bin.charCodeAt(i);
          return api('/api/photos', { method: 'POST', headers: { 'Content-Type': ph.mime }, body: a }).then(function(r){ map[ph.id] = r.id; });
        }); }, Promise.resolve()).then(function(){
          var days = d.days || [];
          return days.reduce(function(p, day){ return p.then(function(){
            (day.data.events || []).forEach(function(e){ if(e.photo && map[e.photo]) e.photo = map[e.photo]; });
            return api('/api/days/' + day.date, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(day.data) });
          }); }, Promise.resolve()).then(function(){
            var s = (d.settings || {}).zoe;
            return s ? api('/api/settings/zoe', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }) : null;
          }).then(function(){ msg.textContent = 'Imported ' + days.length + ' days and ' + photos.length + ' photos.'; setTimeout(function(){ location.reload(); }, 1200); });
        });
      }).catch(function(){ msg.textContent = 'Could not import that file.'; });
    };
  }

  document.addEventListener('DOMContentLoaded', function(){
    // Passcode is turned off (REQUIRE_PASSCODE in worker/wrangler.toml), so open straight away.
    if(!API) showLogin(); else readyResolve();
    alertsCard();
    if('serviceWorker' in navigator && Notification && Notification.permission === 'granted') navigator.serviceWorker.register('sw.js').catch(function(){});
  });
})();
