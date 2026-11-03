/* 서버 모드: UNO Q 같은 기기에서 띄우면 여러 태블릿이 같은 좌석 현황을 본다. 외부 패키지 없이 Node 내장 모듈만 쓴다. */
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const Core = require('../public/js/core.js');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const RESET_PIN_FILE = path.join(DATA_DIR, 'reset-pin');
const EVENTS_TOKEN = process.env.EVENTS_TOKEN || '';
const SESSION_MS = 12 * 60 * 60 * 1000;

const layout = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'layout.json'), 'utf8'));
fs.mkdirSync(HISTORY_DIR, { recursive: true });

/* PIN은 scrypt 해시로만 저장한다 */
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('base64url');
  return 'scrypt$' + salt + '$' + crypto.scryptSync(String(pin), salt, 32).toString('base64url');
}
function pinMatches(pin, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const a = crypto.scryptSync(String(pin), salt, 32), b = Buffer.from(hash, 'base64url');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const validPin = (p) => /^\d{4,8}$/.test(String(p || ''));

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s && s.version === 1) {
      s.settings = Object.assign(Core.defaultSettings(), s.settings);
      /* data/roster.csv가 없으면 기본 명단 파일을 따라간다 (명단 파일이 바뀌면 새 이름으로) */
      if (!fs.existsSync(path.join(DATA_DIR, 'roster.csv'))) {
        Core.syncDefaultRoster(s, JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'roster.json'), 'utf8')));
      }
      return s;
    }
  } catch (e) {}
  let roster;
  const csv = path.join(DATA_DIR, 'roster.csv');
  const fromCsv = fs.existsSync(csv);
  if (fromCsv) roster = Core.parseRosterCsv(fs.readFileSync(csv, 'utf8'));
  else roster = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'roster.json'), 'utf8'));
  const s = Core.emptyState(roster);
  if (fromCsv) s.rosterTag = 'custom';
  if (validPin(process.env.ADMIN_PIN)) s.settings.pin = process.env.ADMIN_PIN;
  if (process.env.DEMO_MODE === '0') s.settings.demoMode = false;
  return s;
}

let state = loadState();
/* 예전 버전의 평문 PIN은 해시로 바꾼다 */
if (!state.settings.pinHash) {
  const first = validPin(state.settings.pin) ? state.settings.pin : '0000';
  state.settings.pinHash = hashPin(first);
  state.settings.pinLength = first.length;
}
delete state.settings.pin;

function save() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

/* 날짜가 바뀌면 어제 기록을 history/날짜.json으로 남기고 좌석을 비운다 */
function writeHistory(rec) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.day)) return;
  const file = path.join(HISTORY_DIR, rec.day + '.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(rec));
  fs.renameSync(file + '.tmp', file);
}
function roll() {
  if (state.day === Core.todayKey()) return;
  if (state.log.length) writeHistory(Core.dayRecord(state));
  Core.rollDay(state);
  save();
}
roll();
save();

/* 잊어버린 PIN 되돌리기: ./deploy.sh reset-pin 이 data/reset-pin 파일에 새 PIN을 써 둔다 */
function checkResetPin() {
  if (!fs.existsSync(RESET_PIN_FILE)) return;
  const p = fs.readFileSync(RESET_PIN_FILE, 'utf8').trim();
  fs.unlinkSync(RESET_PIN_FILE);
  if (!validPin(p)) { console.warn('reset-pin: PIN은 숫자 4~8자리여야 합니다'); return; }
  state.settings.pinHash = hashPin(p);
  state.settings.pinLength = p.length;
  sessions.clear();
  save();
  console.log('감독 PIN을 새로 정했습니다');
}

/* 감독 로그인 세션 */
const sessions = new Map();   // token -> 만료 시각
function newSession() {
  const token = crypto.randomBytes(24).toString('base64url');
  sessions.set(token, Date.now() + SESSION_MS);
  return token;
}
function authed(token) {
  const exp = token && sessions.get(String(token));
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/* PIN을 계속 틀리면 기다리게 한다: 5번 틀리면 30초, 그 뒤로 틀릴 때마다 두 배 (최대 15분) */
const failures = new Map();   // 접속한 곳 -> { n, until }
function clientKey(req) {
  return String(req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
}
function waitLeft(key) {
  const f = failures.get(key);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function failed(key) {
  const f = failures.get(key) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) f.until = Date.now() + Math.min(30000 * Math.pow(2, f.n - 5), 15 * 60000);
  failures.set(key, f);
  return waitLeft(key);
}

/* 감독 PIN은 응답에서 뺀다 */
function publicState() {
  roll();
  const s = JSON.parse(JSON.stringify(state));
  delete s.settings.pinHash;
  delete s.settings.pin;
  s.settings.pinLength = state.settings.pinLength || 4;
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

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > (limit || 2e6)) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
  });
}

/* 1KB 넘는 글자 응답은 gzip으로 줄여 보낸다 (태블릿 와이파이가 느릴 때를 위해) */
function finish(res, code, headers, buf, compressible) {
  const req = res.req;
  if (compressible && buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
  }
  headers.Vary = 'Accept-Encoding';
  res.writeHead(code, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

/* 바뀐 게 없으면 304만 돌려준다 */
function notModified(res, etag) {
  if (res.req.headers['if-none-match'] !== etag) return false;
  res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
  res.end();
  return true;
}

function send(res, code, obj) {
  finish(res, code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, Buffer.from(JSON.stringify(obj)), true);
}

function sendCsv(res, name, text) {
  finish(res, 200, {
    'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name)
  }, Buffer.from('﻿' + text), true);
}

/* 좌석 현황은 3초마다 불러가므로 ETag를 붙여 바뀌지 않았으면 304로 끝낸다 */
function sendState(res, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  const etag = '"' + crypto.createHash('sha1').update(buf).digest('base64url') + '"';
  if (notModified(res, etag)) return;
  finish(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: etag }, buf, true);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.csv': 'text/csv; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('없는 페이지입니다.'); return; }
    const etag = '"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
    if (notModified(res, etag)) return;
    fs.readFile(file, (err2, buf) => {
      if (err2) { res.writeHead(500); res.end(); return; }
      const ext = path.extname(file);
      finish(res, 200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag }, buf, ext !== '.woff2' && ext !== '.png');
    });
  });
}

/* 지난 기록 */
function historyDays() {
  return fs.readdirSync(HISTORY_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse();
}
function readHistory(day) {
  if (day === state.day) return Core.dayRecord(state);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, day + '.json'), 'utf8')); } catch (e) { return null; }
}
function summary(rec) {
  const night = new Set(rec.night);
  const came = Object.keys(rec.students);
  return { day: rec.day, night: night.size, came: came.filter((id) => night.has(id)).length, extra: came.filter((id) => !night.has(id)).length, early: came.filter((id) => rec.students[id].early).length };
}

const csvCell = (v) => { v = String(v === undefined || v === null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const hm = (iso) => (iso ? Core.hhmm(new Date(iso)) : '');

/* 기간 출석부: 학생마다 날짜별로 출석(O), 조퇴, 결석(X), 신청 안 함(빈칸) */
function attendanceCsv(from, to) {
  const days = historyDays().concat(state.log.length ? [state.day] : []).filter((d, i, a) => a.indexOf(d) === i && d >= from && d <= to).sort();
  const recs = days.map(readHistory).filter(Boolean);
  const names = new Map(state.roster.map((s) => [s.id, s.name]));
  recs.forEach((r) => Object.entries(r.names || {}).forEach(([id, n]) => { if (!names.has(id)) names.set(id, n); }));
  const ids = new Set();
  recs.forEach((r) => { r.night.forEach((id) => ids.add(id)); Object.keys(r.students).forEach((id) => ids.add(id)); });
  const head = ['학번', '이름'].concat(recs.map((r) => r.day.slice(5).replace('-', '/')), ['출석', '결석', '조퇴']);
  const lines = [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((id) => {
    let o = 0, x = 0, e = 0;
    const cells = recs.map((r) => {
      const s = r.students[id];
      if (s) { if (s.early) { e += 1; return '조퇴'; } o += 1; return 'O'; }
      if (r.night.indexOf(id) !== -1) { x += 1; return 'X'; }
      return '';
    });
    return [id, names.get(id) || ''].concat(cells, [o, x, e]).map(csvCell).join(',');
  });
  return { days: recs.length, text: head.map(csvCell).join(',') + '\n' + lines.join('\n') };
}

/* 하루 기록 CSV: 학생마다 들어온 시각, 자리, 나간 시각 */
function dayCsv(rec) {
  const night = new Set(rec.night);
  const names = rec.names || {};
  const ids = new Set(rec.night.concat(Object.keys(rec.students)));
  const typeName = { assign: '배정', move: '이동', release: '반납', out: '외출', back: '돌아옴' };
  const rows = [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((id) => {
    const s = rec.students[id];
    const status = s ? (s.early ? '조퇴' : '출석') : '결석';
    return [id, (s && s.name) || names[id] || '', night.has(id) ? '신청' : '안 함', status, s ? s.seat : '', s ? hm(s.in) : '', s ? hm(s.left) : '', s ? s.outs : ''].map(csvCell).join(',');
  });
  const log = rec.log.slice().reverse().map((l) => [hm(l.at), typeName[l.type] || l.type, l.id, l.name, l.seat, l.note === 'early' ? '조퇴' : '', l.by === 'teacher' ? '감독' : '키오스크'].map(csvCell).join(','));
  return '학번,이름,야자 신청,출석,자리,들어온 시각,나간 시각,외출 횟수\n' + rows.join('\n')
    + '\n\n시각,구분,학번,이름,자리,메모,처리\n' + log.join('\n');
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/health') return send(res, 200, { ok: true });
    if (p === '/api/state' && req.method === 'GET') return sendState(res, publicState());

    if (p === '/api/login' && req.method === 'POST') {
      checkResetPin();
      const key = clientKey(req);
      const wait = waitLeft(key);
      if (wait) return send(res, 200, { ok: false, wait });
      const b = await readBody(req);
      if (!pinMatches(b.pin, state.settings.pinHash)) return send(res, 200, { ok: false, wait: failed(key) });
      failures.delete(key);
      return send(res, 200, { ok: true, token: newSession() });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const b = await readBody(req);
      sessions.delete(String(b.token || ''));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/session' && req.method === 'GET') return send(res, 200, { ok: authed(bearer(req)) });

    if (p === '/api/action' && req.method === 'POST') {
      const action = await readBody(req);
      roll();
      const needAuth = Core.ADMIN_TYPES.has(action.type) || action.byTeacher;
      if (needAuth && !authed(action.token)) {
        return send(res, 200, { result: { ok: false, error: '다시 로그인해 주세요', auth: true }, state: publicState() });
      }
      if (action.type === 'change-pin') {
        const key = clientKey(req);
        if (waitLeft(key)) return send(res, 200, { result: { ok: false, error: '잠시 뒤에 다시 해 주세요' }, state: publicState() });
        if (!pinMatches(action.current, state.settings.pinHash)) { failed(key); return send(res, 200, { result: { ok: false, error: '지금 PIN이 맞지 않아요' }, state: publicState() }); }
        if (!validPin(action.next)) return send(res, 200, { result: { ok: false, error: 'PIN은 숫자 4~8자리로 정해 주세요' }, state: publicState() });
        state.settings.pinHash = hashPin(action.next);
        state.settings.pinLength = String(action.next).length;
        sessions.clear();
        save();
        return send(res, 200, { result: { ok: true, token: newSession() }, state: publicState() });
      }
      const before = state.events.length;
      const result = Core.apply(state, layout, action);
      if (result.ok) {
        save();
        state.events.slice(before).forEach(postWebhook);
      }
      return send(res, 200, { result, state: publicState() });
    }

    /* 감독만 볼 수 있는 기록과 백업 (Authorization: Bearer 토큰) */
    if (p.startsWith('/api/history') || p === '/api/attendance.csv' || p === '/api/backup' || p === '/api/restore') {
      if (!authed(bearer(req))) return send(res, 401, { ok: false, error: '다시 로그인해 주세요', auth: true });
      roll();
      if (p === '/api/history' && req.method === 'GET') {
        const days = historyDays();
        if (state.log.length && days.indexOf(state.day) === -1) days.unshift(state.day);
        return send(res, 200, { ok: true, days: days.map((d) => summary(readHistory(d))) });
      }
      if (p === '/api/history.csv' && req.method === 'GET') {
        const rec = readHistory(url.searchParams.get('day') || '');
        if (!rec) return send(res, 404, { ok: false, error: '그날 기록이 없어요' });
        return sendCsv(res, '야자기록_' + rec.day + '.csv', dayCsv(rec));
      }
      if (p === '/api/attendance.csv' && req.method === 'GET') {
        const from = url.searchParams.get('from') || '0000-00-00', to = url.searchParams.get('to') || '9999-99-99';
        const r = attendanceCsv(from, to);
        return sendCsv(res, '야자출석부_' + from + '_' + to + '.csv', r.text);
      }
      if (p === '/api/backup' && req.method === 'GET') {
        const s = JSON.parse(JSON.stringify(state));
        delete s.settings.pinHash;
        const history = {};
        historyDays().forEach((d) => { history[d] = readHistory(d); });
        const body = Buffer.from(JSON.stringify({ kind: 'study-room-kiosk-backup', at: new Date().toISOString(), state: s, history }));
        return finish(res, 200, {
          'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent('자습실백업_' + Core.todayKey() + '.json')
        }, body, true);
      }
      if (p === '/api/restore' && req.method === 'POST') {
        const b = await readBody(req, 50e6);
        const s = b && b.kind === 'study-room-kiosk-backup' && b.state;
        if (!s || s.version !== 1 || !Array.isArray(s.roster) || typeof s.seats !== 'object') return send(res, 200, { ok: false, error: '이 앱의 백업 파일이 아니에요' });
        const err = Core.checkRoster(s.roster);
        if (err) return send(res, 200, { ok: false, error: '백업의 명단에 문제가 있어요. ' + err });
        const pinHash = state.settings.pinHash, pinLength = state.settings.pinLength;
        s.settings = Object.assign(Core.defaultSettings(), s.settings, { pinHash, pinLength });
        delete s.settings.pin;
        s.log = Array.isArray(s.log) ? s.log : [];
        s.events = Array.isArray(s.events) ? s.events : [];
        s.rosterTag = 'custom';
        Object.values(b.history || {}).forEach((rec) => { if (rec && rec.day && Array.isArray(rec.night) && rec.students) writeHistory(rec); });
        state = s;
        roll();
        save();
        return send(res, 200, { ok: true, state: publicState() });
      }
      return send(res, 404, { ok: false });
    }

    /* 알림 봇이 가져가는 배정 알림 목록: GET /api/events?since=ISO시각&token=… */
    if (p === '/api/events' && req.method === 'GET') {
      if (EVENTS_TOKEN && url.searchParams.get('token') !== EVENTS_TOKEN) return send(res, 403, { ok: false });
      roll();
      const since = url.searchParams.get('since') || '';
      return send(res, 200, { ok: true, events: state.events.filter((e) => e.at > since) });
    }

    if (p.startsWith('/api/')) return send(res, 404, { ok: false });
    serveStatic(req, res, p);
  } catch (e) {
    send(res, 400, { ok: false, error: e.message });
  }
}

checkResetPin();
/* 자정이 지나도 아무 요청이 없을 수 있으니 1분마다 날짜를 확인한다 */
setInterval(roll, 60000).unref();
/* 오래된 세션과 틀린 기록 치우기 */
setInterval(() => {
  const now = Date.now();
  sessions.forEach((exp, t) => { if (exp < now) sessions.delete(t); });
  failures.forEach((f, k) => { if (f.until < now - 3600000) failures.delete(k); });
}, 600000).unref();

const cert = process.env.TLS_CERT, key = process.env.TLS_KEY;
const server = cert && key && fs.existsSync(cert) && fs.existsSync(key)
  ? https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, handler)
  : http.createServer(handler);
server.listen(PORT, () => {
  console.log('좌석 배정 서버 ' + (server instanceof https.Server ? 'https' : 'http') + '://0.0.0.0:' + PORT);
});
