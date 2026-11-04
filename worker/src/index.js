// Zoe's Tracker API: passcode sign-in, day logs, settings, photos, and web push reminders.
// Storage: Cloudflare D1 (binding DB). Push: Web Push with VAPID + aes128gcm payload encryption.

const enc = new TextEncoder();

function b64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function randomId(bytes = 24) { return b64u(crypto.getRandomValues(new Uint8Array(bytes))); }

// ---------- HTTP helpers ----------
function cors(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allow = origin === env.ALLOWED_ORIGIN || origin.startsWith('http://localhost') ? origin : env.ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function json(env, req, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(env, req) } });
}

// ---------- KV helpers ----------
async function kvGet(env, k) {
  const r = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
  return r ? r.v : null;
}
async function kvSet(env, k, v) {
  await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v).run();
}

// ---------- passcode ----------
async function hashPasscode(pass, saltB64) {
  const salt = saltB64 ? unb64u(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return { salt: b64u(salt), hash: b64u(bits) };
}
async function newSession(env) {
  const token = randomId(32);
  await env.DB.prepare('INSERT INTO sessions (token, created) VALUES (?, ?)').bind(token, Date.now()).run();
  return token;
}
async function authed(env, req, url) {
  const h = req.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (url.searchParams.get('t') || '');
  if (!token) return false;
  const r = await env.DB.prepare('SELECT token FROM sessions WHERE token = ?').bind(token).first();
  return !!r;
}

// ---------- VAPID / Web Push ----------
async function vapidKeys(env) {
  const stored = await kvGet(env, 'vapid');
  if (stored) {
    const v = JSON.parse(stored);
    const priv = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return { priv, pub: v.pub };
  }
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
  await kvSet(env, 'vapid', JSON.stringify({ jwk, pub }));
  return { priv: kp.privateKey, pub };
}
async function vapidAuth(env, endpoint) {
  const { priv, pub } = await vapidKeys(env);
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const unsigned = header + '.' + claims;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${pub}`;
}
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}
async function encryptPayload(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const plain = concat(enc.encode(payload), new Uint8Array([2]));
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}
async function sendPush(env, sub, payloadObj) {
  const body = await encryptPayload(sub, JSON.stringify(payloadObj));
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': await vapidAuth(env, sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '3600',
      'Urgency': 'high',
    },
    body,
  });
}
async function pushAll(env, payloadObj) {
  const { results } = await env.DB.prepare('SELECT endpoint, data FROM subs').all();
  let sent = 0;
  for (const r of results || []) {
    try {
      const res = await sendPush(env, JSON.parse(r.data), payloadObj);
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?').bind(r.endpoint).run();
      } else if (res.ok) sent++;
    } catch (e) { /* skip this subscription */ }
  }
  return sent;
}

// ---------- routes ----------
async function handle(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, req) });

  if (p === '/api/status') {
    return json(env, req, { setup: !!(await kvGet(env, 'passcode')) });
  }
  if (p === '/api/setup' && req.method === 'POST') {
    if (await kvGet(env, 'passcode')) return json(env, req, { error: 'already_set' }, 409);
    const { passcode } = await req.json();
    if (!passcode || String(passcode).length < 4) return json(env, req, { error: 'too_short' }, 400);
    await kvSet(env, 'passcode', JSON.stringify(await hashPasscode(String(passcode))));
    return json(env, req, { token: await newSession(env) });
  }
  if (p === '/api/login' && req.method === 'POST') {
    const stored = await kvGet(env, 'passcode');
    if (!stored) return json(env, req, { error: 'not_setup' }, 400);
    const { passcode } = await req.json();
    const s = JSON.parse(stored);
    const h = await hashPasscode(String(passcode || ''), s.salt);
    if (h.hash !== s.hash) return json(env, req, { error: 'wrong' }, 401);
    return json(env, req, { token: await newSession(env) });
  }
  if (p === '/api/push/key') {
    return json(env, req, { key: (await vapidKeys(env)).pub });
  }

  if (!(await authed(env, req, url))) return json(env, req, { error: 'auth' }, 401);

  // days
  if (p === '/api/days' && req.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT date, data, updated FROM days ORDER BY date ASC LIMIT 2000').all();
    return json(env, req, { days: (results || []).map(r => ({ date: r.date, data: JSON.parse(r.data), updated: r.updated })) });
  }
  let m = p.match(/^\/api\/days\/(\d{4}-\d{2}-\d{2})$/);
  if (m) {
    if (req.method === 'GET') {
      const r = await env.DB.prepare('SELECT data, updated FROM days WHERE date = ?').bind(m[1]).first();
      return json(env, req, r ? { exists: true, data: JSON.parse(r.data), updated: r.updated } : { exists: false });
    }
    if (req.method === 'PUT') {
      const body = await req.text();
      JSON.parse(body);
      const now = Date.now();
      await env.DB.prepare('INSERT INTO days (date, data, updated) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET data = excluded.data, updated = excluded.updated').bind(m[1], body, now).run();
      return json(env, req, { ok: true, updated: now });
    }
  }
  // settings
  m = p.match(/^\/api\/settings\/([a-z0-9_-]+)$/);
  if (m) {
    if (req.method === 'GET') {
      const r = await env.DB.prepare('SELECT data FROM settings WHERE id = ?').bind(m[1]).first();
      return json(env, req, r ? { exists: true, data: JSON.parse(r.data) } : { exists: false });
    }
    if (req.method === 'PUT') {
      const body = await req.text();
      JSON.parse(body);
      await env.DB.prepare('INSERT INTO settings (id, data, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated').bind(m[1], body, Date.now()).run();
      return json(env, req, { ok: true });
    }
  }
  // photos
  if (p === '/api/photos' && req.method === 'POST') {
    const mime = (req.headers.get('Content-Type') || '').split(';')[0];
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) return json(env, req, { error: 'type' }, 415);
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 1800000) return json(env, req, { error: 'too_large' }, 413);
    const id = randomId(16);
    await env.DB.prepare('INSERT INTO photos (id, mime, data, created) VALUES (?, ?, ?, ?)').bind(id, mime, buf, Date.now()).run();
    return json(env, req, { id });
  }
  m = p.match(/^\/api\/photos\/([A-Za-z0-9_-]+)$/);
  if (m) {
    if (req.method === 'GET') {
      const r = await env.DB.prepare('SELECT mime, data FROM photos WHERE id = ?').bind(m[1]).first();
      if (!r) return new Response('Not found', { status: 404, headers: cors(env, req) });
      return new Response(new Uint8Array(r.data), { headers: { 'Content-Type': r.mime, 'Cache-Control': 'private, max-age=31536000, immutable', ...cors(env, req) } });
    }
    if (req.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(m[1]).run();
      return json(env, req, { ok: true });
    }
  }
  // push subscriptions
  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const sub = await req.json();
    if (!sub || !sub.endpoint || !sub.keys) return json(env, req, { error: 'bad' }, 400);
    await env.DB.prepare('INSERT INTO subs (endpoint, data, created) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET data = excluded.data').bind(sub.endpoint, JSON.stringify(sub), Date.now()).run();
    return json(env, req, { ok: true });
  }
  if (p === '/api/push/test' && req.method === 'POST') {
    const sent = await pushAll(env, { title: "Zoe's Tracker", body: 'Alerts are working. You will get a ping when it is time to feed her.', tag: 'test' });
    return json(env, req, { sent });
  }
  // reminders
  if (p === '/api/reminders' && req.method === 'POST') {
    const r = await req.json();
    if (!r || !r.tag || !r.at) return json(env, req, { error: 'bad' }, 400);
    await env.DB.prepare('INSERT INTO reminders (tag, at, title, body, sent) VALUES (?, ?, ?, ?, 0) ON CONFLICT(tag) DO UPDATE SET at = excluded.at, title = excluded.title, body = excluded.body, sent = 0').bind(String(r.tag), Number(r.at), String(r.title || "Zoe's Tracker"), String(r.body || '')).run();
    return json(env, req, { ok: true });
  }
  m = p.match(/^\/api\/reminders\/([A-Za-z0-9_:.-]+)$/);
  if (m && req.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM reminders WHERE tag = ?').bind(m[1]).run();
    return json(env, req, { ok: true });
  }

  return json(env, req, { error: 'not_found' }, 404);
}

async function runReminders(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare('SELECT tag, at, title, body FROM reminders WHERE sent = 0 AND at <= ?').bind(now).all();
  for (const r of results || []) {
    await env.DB.prepare('UPDATE reminders SET sent = 1 WHERE tag = ?').bind(r.tag).run();
    if (now - r.at < 3 * 3600 * 1000) await pushAll(env, { title: r.title, body: r.body, tag: r.tag });
  }
  // tidy: drop reminders sent more than a week ago and sessions older than a year
  await env.DB.prepare('DELETE FROM reminders WHERE sent = 1 AND at < ?').bind(now - 7 * 86400000).run();
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return json(env, req, { error: 'server', message: String(e && e.message || e) }, 500); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
};
