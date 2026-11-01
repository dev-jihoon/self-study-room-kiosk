/* 서버 모드: UNO Q 같은 기기에서 띄우면 여러 태블릿이 같은 좌석 현황을 본다. 외부 패키지 없이 Node 내장 모듈만 쓴다. */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Core = require('../public/js/core.js');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const EVENTS_TOKEN = process.env.EVENTS_TOKEN || '';
const ADMIN_TYPES = new Set(['reset', 'settings', 'roster']);

const layout = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'layout.json'), 'utf8'));
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s && s.version === 1) { s.settings = Object.assign(Core.defaultSettings(), s.settings); return s; }
  } catch (e) {}
  let roster;
  const csv = path.join(DATA_DIR, 'roster.csv');
  if (fs.existsSync(csv)) roster = Core.parseRosterCsv(fs.readFileSync(csv, 'utf8'));
  else roster = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'roster.json'), 'utf8'));
  const s = Core.emptyState(roster);
  if (process.env.ADMIN_PIN) s.settings.pin = process.env.ADMIN_PIN;
  if (process.env.DEMO_MODE === '0') s.settings.demoMode = false;
  return s;
}

let state = loadState();
function save() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}
save();

/* 감독 PIN은 응답에서 뺀다 */
function publicState() {
  Core.rollDay(state);
  const s = JSON.parse(JSON.stringify(state));
  delete s.settings.pin;
  return s;
}

function postWebhook(ev) {
  const url = state.settings.webhookUrl;
  if (!url) return;
  try {
    const u = new URL(url);
    const body = Buffer.from(JSON.stringify(ev));
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }, timeout: 5000
    });
    req.on('error', (e) => console.warn('webhook 실패:', e.message));
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch (e) { console.warn('webhook 주소 오류:', e.message); }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 1e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.png': 'image/png'
};

function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('없는 페이지입니다.'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/health') return send(res, 200, { ok: true });
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, publicState());

    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, { ok: String(b.pin || '') === state.settings.pin });
    }

    if (p === '/api/action' && req.method === 'POST') {
      const action = await readBody(req);
      if ((ADMIN_TYPES.has(action.type) || action.byTeacher) && String(action.pin || '') !== state.settings.pin) {
        return send(res, 200, { result: { ok: false, error: 'PIN이 맞지 않습니다.' }, state: publicState() });
      }
      const before = state.events.length;
      const result = Core.apply(state, layout, action);
      if (result.ok) {
        save();
        state.events.slice(before).forEach(postWebhook);
      }
      return send(res, 200, { result, state: publicState() });
    }

    /* 알림 봇이 가져가는 배정 알림 목록: GET /api/events?since=ISO시각&token=… */
    if (p === '/api/events' && req.method === 'GET') {
      if (EVENTS_TOKEN && url.searchParams.get('token') !== EVENTS_TOKEN) return send(res, 403, { ok: false });
      Core.rollDay(state);
      const since = url.searchParams.get('since') || '';
      return send(res, 200, { ok: true, events: state.events.filter((e) => e.at > since) });
    }

    if (p.startsWith('/api/')) return send(res, 404, { ok: false });
    serveStatic(req, res, p);
  } catch (e) {
    send(res, 400, { ok: false, error: e.message });
  }
}

const cert = process.env.TLS_CERT, key = process.env.TLS_KEY;
const server = cert && key && fs.existsSync(cert) && fs.existsSync(key)
  ? https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, handler)
  : http.createServer(handler);
server.listen(PORT, () => {
  console.log('좌석 배정 서버 ' + (server instanceof https.Server ? 'https' : 'http') + '://0.0.0.0:' + PORT);
});
