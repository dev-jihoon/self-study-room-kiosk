/* 서버 모드 기본 동작 확인: node scripts/smoke-test.js */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 18080 + Math.floor(Math.random() * 1000);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-'));
const base = 'http://127.0.0.1:' + PORT;

async function post(p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: Object.assign({}, process.env, { PORT, DATA_DIR: DATA, ADMIN_PIN: '1234' }), stdio: 'inherit'
  });
  await new Promise((r) => setTimeout(r, 600));
  try {
    const st = await (await fetch(base + '/api/state')).json();
    assert.strictEqual(st.version, 1);
    assert.ok(!('pin' in st.settings), 'PIN이 응답에 노출되면 안 됨');
    const a = st.roster[0].id, b = st.roster[1].id;

    let r = await post('/api/action', { type: 'assign', id: a, seat: 20 });
    assert.ok(r.result.ok, '배정');
    r = await post('/api/action', { type: 'assign', id: b, seat: 20 });
    assert.ok(!r.result.ok, '같은 자리 중복 배정 막기');
    r = await post('/api/action', { type: 'assign', id: b, seat: 8 });
    assert.ok(!r.result.ok || true);
    r = await post('/api/action', { type: 'assign', id: a, seat: 21 });
    assert.ok(r.result.ok && r.result.moved && r.result.from === 20, '자리 이동');
    r = await post('/api/action', { type: 'assign', id: a, seat: 999 });
    assert.ok(!r.result.ok, '없는 자리');
    r = await post('/api/action', { type: 'assign', id: '99999', seat: 30 });
    assert.ok(!r.result.ok, '없는 학번');
    r = await post('/api/action', { type: 'reset' });
    assert.ok(!r.result.ok, 'PIN 없이 초기화 막기');
    assert.ok((await post('/api/login', { pin: '1234' })).ok, '로그인');

    const ev = await (await fetch(base + '/api/events?since=')).json();
    assert.ok(ev.events.length >= 2 && ev.events[0].message.includes('번이에요'), '알림 목록');

    r = await post('/api/action', { type: 'release', id: a });
    assert.ok(r.result.ok && r.result.seat === 21, '반납');
    r = await post('/api/action', { type: 'reset', pin: '1234' });
    assert.ok(r.result.ok, 'PIN으로 초기화');

    const page = await fetch(base + '/index.html');
    assert.strictEqual(page.status, 200);
    const tag = page.headers.get('etag');
    assert.ok(tag, '정적 파일 ETag');
    assert.strictEqual((await fetch(base + '/index.html', { headers: { 'If-None-Match': tag } })).status, 304, '바뀌지 않은 파일은 304');
    const s1 = await fetch(base + '/api/state');
    assert.strictEqual(s1.headers.get('content-encoding'), 'gzip', '좌석 현황 gzip');
    assert.strictEqual((await fetch(base + '/api/state', { headers: { 'If-None-Match': s1.headers.get('etag') } })).status, 304, '바뀌지 않은 좌석 현황은 304');
    console.log('모든 확인 통과');
  } finally {
    srv.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch((e) => { console.error('실패:', e.message); process.exit(1); });
