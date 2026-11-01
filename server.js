// Annadil Football — tiny server, no dependencies.
// Data is one JSON file on a Railway volume (plus daily backups).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PIN = String(process.env.ADMIN_PIN || '1234');
const GROUP_PIN = String(process.env.GROUP_PIN || '0000');
const FILE = path.join(DATA_DIR, 'state.json');
const BACKUPS = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUPS, { recursive: true });

const EMPTY = () => ({ v: 1, rev: 0, settings: { group: 'Annadil Football', cost: 110000, round: 1000, payTo: '' }, players: [], sessions: [], settlements: [] });
function clean(o) {
  const e = EMPTY(); o = o && typeof o === 'object' ? o : {};
  const settings = { ...e.settings, ...(o.settings || {}) }; delete settings.pin;
  return { ...e, ...o, settings, players: Array.isArray(o.players) ? o.players : [], sessions: Array.isArray(o.sessions) ? o.sessions : [], settlements: Array.isArray(o.settlements) ? o.settlements : [] };
}
let S;
try { S = clean(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { S = EMPTY(); }

function persist() {
  S.rev = (S.rev || 0) + 1;
  const json = JSON.stringify(S);
  fs.writeFileSync(FILE + '.tmp', json); fs.renameSync(FILE + '.tmp', FILE);
  fs.writeFileSync(path.join(BACKUPS, new Date().toISOString().slice(0, 10) + '.json'), json);
  const old = fs.readdirSync(BACKUPS).sort(); while (old.length > 90) fs.unlinkSync(path.join(BACKUPS, old.shift()));
}

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const uid = () => crypto.randomBytes(5).toString('hex');
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

// wrong-PIN throttle: 10 tries per 15 min per IP
const fails = new Map();
function role(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const f = fails.get(ip); if (f && f.n >= 10 && Date.now() - f.t < 15 * 60e3) return 'locked';
  const pin = req.headers['x-pin'] || '';
  if (eq(pin, ADMIN_PIN)) return 'admin';
  if (eq(pin, GROUP_PIN)) return 'player';
  if (pin) { const g = f && Date.now() - f.t < 15 * 60e3 ? f : { n: 0, t: Date.now() }; g.n++; fails.set(ip, g); }
  return null;
}

function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function body(req) {
  return new Promise((ok, bad) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 3e6) { bad(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { bad(e); } });
  });
}
const upcomingSession = id => S.sessions.find(s => s.id === id && s.status === 'upcoming');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (url.pathname !== '/' && url.pathname !== '/index.html') { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }
    const r = role(req);
    if (r === 'locked') return send(res, 429, { error: 'Too many wrong PINs. Try again in 15 minutes.' });
    if (!r) return send(res, 401, { error: 'Wrong PIN' });

    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { role: r, state: S });

    if (req.method === 'PUT' && url.pathname === '/api/state') {
      if (r !== 'admin') return send(res, 403, { error: 'Admin only' });
      const b = await body(req);
      if (b.baseRev !== S.rev) return send(res, 409, { error: 'Changed elsewhere', state: S });
      S = clean(b.state); S.rev = b.baseRev; persist();
      return send(res, 200, { rev: S.rev });
    }

    if (req.method === 'POST') {
      const b = await body(req);
      if (url.pathname === '/api/join') {
        const name = String(b.name || '').trim().slice(0, 40);
        if (!name) return send(res, 400, { error: 'Name needed' });
        let p = S.players.find(p => norm(p.name) === norm(name));
        if (!p) { p = { id: uid(), name, phone: '', alias: [], active: true, joined: Date.now() }; S.players.push(p); persist(); }
        return send(res, 200, { player: p, state: S });
      }
      if (url.pathname === '/api/vote') {
        const s = upcomingSession(b.sessionId), pid = b.playerId;
        if (!s) return send(res, 400, { error: 'Voting is closed for this game' });
        if (!S.players.some(p => p.id === pid)) return send(res, 400, { error: 'Unknown player' });
        s.attendees = (s.attendees || []).filter(x => x !== pid); s.out = (s.out || []).filter(x => x !== pid);
        if (b.vote === 'in') s.attendees.push(pid);
        if (b.vote === 'out') { s.out.push(pid); s.guests = (s.guests || []).filter(g => g.host !== pid); }
        persist(); return send(res, 200, { state: S });
      }
      if (url.pathname === '/api/guest') {
        const s = upcomingSession(b.sessionId);
        if (!s) return send(res, 400, { error: 'Voting is closed for this game' });
        const name = String(b.name || '').trim().slice(0, 40);
        if (!name || !S.players.some(p => p.id === b.host)) return send(res, 400, { error: 'Name needed' });
        if (!(s.attendees || []).includes(b.host)) s.attendees = [...(s.attendees || []), b.host];
        s.out = (s.out || []).filter(x => x !== b.host);
        s.guests = [...(s.guests || []), { id: uid(), name, host: b.host, payer: b.payer === 'self' ? 'self' : 'host' }];
        persist(); return send(res, 200, { state: S });
      }
      if (url.pathname === '/api/guest/remove') {
        const s = upcomingSession(b.sessionId);
        if (!s) return send(res, 400, { error: 'Voting is closed for this game' });
        s.guests = (s.guests || []).filter(g => !(g.id === b.guestId && (r === 'admin' || g.host === b.host)));
        persist(); return send(res, 200, { state: S });
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) { send(res, 400, { error: String(e.message || e) }); }
});
server.listen(PORT, () => console.log(`Annadil Football on :${PORT}, data in ${DATA_DIR}`));
