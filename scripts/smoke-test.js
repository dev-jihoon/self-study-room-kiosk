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

function start() {
  return spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: Object.assign({}, process.env, { PORT, DATA_DIR: DATA, ADMIN_PIN: '1234' }), stdio: 'inherit'
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let srv = start();
  await wait(700);
  try {
    const st = await (await fetch(base + '/api/state')).json();
    assert.strictEqual(st.version, 1);
    assert.ok(!('pin' in st.settings) && !('pinHash' in st.settings), 'PIN이 응답에 노출되면 안 됨');
    assert.strictEqual(st.settings.pinLength, 4);
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
    assert.ok(saved.settings.pinHash.startsWith('scrypt$') && !('pin' in saved.settings), 'PIN은 해시로만 저장');
    const a = st.roster[0].id, b = st.roster[1].id;
    /* 지정석이 아닌 자리로 시험한다 */
    const fixed = new Set(st.roster.filter((s) => s.seat).map((s) => s.seat));
    const [S1, S2, S3] = Array.from({ length: 107 }, (_, i) => i + 1).filter((n) => !fixed.has(n));

    let r = await post('/api/action', { type: 'assign', id: a, seat: S1 });
    assert.ok(r.result.ok, '배정');
    r = await post('/api/action', { type: 'assign', id: b, seat: S1 });
    assert.ok(!r.result.ok, '같은 자리 중복 배정 막기');
    r = await post('/api/action', { type: 'assign', id: a, seat: S2 });
    assert.ok(r.result.ok && r.result.moved && r.result.from === S1, '자리 이동');
    r = await post('/api/action', { type: 'assign', id: a, seat: 999 });
    assert.ok(!r.result.ok, '없는 자리');
    r = await post('/api/action', { type: 'assign', id: '99999', seat: S3 });
    assert.ok(!r.result.ok, '없는 학번');

    /* 외출 */
    r = await post('/api/action', { type: 'out', id: a });
    assert.ok(r.result.ok && r.state.seats[S2].out, '외출');
    r = await post('/api/action', { type: 'back', id: a });
    assert.ok(r.result.ok && !r.state.seats[S2].out, '돌아옴');

    /* 감독 로그인 */
    r = await post('/api/action', { type: 'reset' });
    assert.ok(!r.result.ok && r.result.auth, '로그인 없이 초기화 막기');
    r = await post('/api/action', { type: 'reset', pin: '1234' });
    assert.ok(!r.result.ok, 'PIN만 보내서는 안 됨 (토큰 필요)');
    assert.ok(!(await post('/api/login', { pin: '9999' })).ok, '틀린 PIN');
    const login = await post('/api/login', { pin: '1234' });
    assert.ok(login.ok && login.token, '로그인');
    let token = login.token;
    assert.ok((await (await fetch(base + '/api/session', { headers: { Authorization: 'Bearer ' + token } })).json()).ok, '세션 확인');

    /* 자리 막기 */
    r = await post('/api/action', { type: 'seat-close', seat: S3, closed: true, token });
    assert.ok(r.result.ok, '자리 막기');
    r = await post('/api/action', { type: 'assign', id: b, seat: S3 });
    assert.ok(!r.result.ok, '막힌 자리 배정 막기');
    r = await post('/api/action', { type: 'seat-close', seat: S3, closed: false, token });
    assert.ok(r.result.ok, '자리 다시 열기');

    /* 명단 */
    r = await post('/api/action', { type: 'student-save', isNew: true, student: { id: '39999', name: 'Testy', night: true }, token });
    assert.ok(r.result.ok && r.state.roster.some((s) => s.id === '39999'), '학생 더하기');
    r = await post('/api/action', { type: 'student-save', isNew: true, student: { id: '39999', name: 'Again' }, token });
    assert.ok(!r.result.ok, '같은 학번 막기');
    r = await post('/api/action', { type: 'student-save', student: { id: a, name: 'Renamed', night: true }, token });
    assert.ok(r.result.ok && r.state.seats[S2].name === 'Renamed', '이름 고치면 자리에도 반영');
    r = await post('/api/action', { type: 'roster-import', mode: 'night', rows: [{ id: a, days: [1, 3] }, { id: '39999' }], token });
    assert.ok(r.result.ok && r.result.night === 2 && r.state.roster.filter((s) => s.days.length).length === 2, '야자 신청만 바꾸기');
    assert.deepStrictEqual(r.state.roster.find((s) => s.id === a).days, [1, 3], '요일별 신청');
    r = await post('/api/action', { type: 'days-set', ids: [a], mode: 'add', day: 5, token });
    assert.deepStrictEqual(r.state.roster.find((s) => s.id === a).days, [1, 3, 5], '요일 더하기');

    /* 지정석: 오늘 신청한 주인이 있으면 다른 학생은 못 앉음 */
    const today = new Date().getDay();
    r = await post('/api/action', { type: 'student-save', isNew: true, student: { id: '39997', name: 'Owner', days: [today], seat: S3 }, token });
    assert.ok(r.result.ok, '지정석 학생 더하기');
    r = await post('/api/action', { type: 'student-save', isNew: true, student: { id: '39996', name: 'Clash', days: [today], seat: S3 }, token });
    assert.ok(!r.result.ok && /겹쳐요/.test(r.result.error), '같은 요일 같은 지정석 막기');
    r = await post('/api/action', { type: 'assign', id: b, seat: S3 });
    assert.ok(!r.result.ok && /지정석/.test(r.result.error), '남의 지정석 막기');
    r = await post('/api/action', { type: 'assign', id: '39997', seat: S3 });
    assert.ok(r.result.ok, '주인은 앉을 수 있음');
    r = await post('/api/action', { type: 'release', id: '39997' });

    /* 못 온다고 알리기 (학생) */
    const tomorrow = await (async () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
    r = await post('/api/action', { type: 'student-save', isNew: true, student: { id: '39995', name: 'Away', days: [0, 1, 2, 3, 4, 5, 6] }, token });
    r = await post('/api/action', { type: 'absence-report', id: '39995', name: 'wrong', reason: '학원' });
    assert.ok(!r.result.ok, '이름이 틀리면 못 알림');
    r = await post('/api/action', { type: 'absence-report', id: '39995', name: 'away', reason: '학원' });
    assert.ok(r.result.ok && r.state.excused['39995'].by === 'student', '오늘 못 온다고 알리기');
    r = await post('/api/action', { type: 'absence-report', id: '39995', name: 'Away', date: tomorrow, reason: '병원 진료' });
    assert.ok(r.result.ok && r.state.planned.some((p) => p.id === '39995' && p.date === tomorrow), '내일 못 온다고 미리 알리기');
    r = await post('/api/action', { type: 'absence-cancel', id: '39995', name: 'Away', date: tomorrow });
    assert.ok(r.result.ok && !r.state.planned.length, '미리 알린 것 취소');
    r = await post('/api/action', { type: 'assign', id: '39995', seat: S1 });
    assert.ok(r.result.ok && !r.state.excused['39995'], '알린 학생이 와서 앉으면 결석이 풀림');
    r = await post('/api/action', { type: 'release', id: '39995' });
    r = await post('/api/action', { type: 'student-delete', ids: ['39995'], token });

    /* 사유 결석 */
    r = await post('/api/action', { type: 'excuse', id: '39997', reason: '병결' });
    assert.ok(!r.result.ok, '사유 결석은 감독만');
    r = await post('/api/action', { type: 'excuse', id: '39997', reason: '병결', token });
    assert.ok(r.result.ok && r.state.excused['39997'].reason === '병결', '사유 결석');
    r = await post('/api/action', { type: 'assign', id: b, seat: S3 });
    assert.ok(r.result.ok, '주인이 결석이면 지정석이 풀림');
    r = await post('/api/action', { type: 'release', id: b });
    r = await post('/api/action', { type: 'student-delete', ids: ['39997'], token });
    r = await post('/api/action', { type: 'roster-import', mode: 'merge', rows: [{ id: '39998', name: 'New' }, { id: a, name: 'Alex2' }], token });
    assert.ok(r.result.ok && r.result.added === 1 && r.result.changed === 1, '명단 더하기');
    r = await post('/api/action', { type: 'roster-import', mode: 'replace', rows: [{ id: '10101', name: 'A' }, { id: '10101', name: 'B' }], token });
    assert.ok(!r.result.ok, '중복 학번 명단 막기');
    r = await post('/api/action', { type: 'student-delete', ids: ['39998', '39999'], token });
    assert.ok(r.result.ok && r.result.count === 2, '학생 지우기');

    const ev = await (await fetch(base + '/api/events?since=')).json();
    assert.ok(ev.events.length >= 2 && ev.events[0].message.includes('번이에요'), '알림 목록');

    /* 기록 */
    assert.strictEqual((await fetch(base + '/api/history')).status, 401, '기록은 로그인 필요');
    const auth = { headers: { Authorization: 'Bearer ' + token } };
    const hist = await (await fetch(base + '/api/history', auth)).json();
    assert.ok(hist.ok && hist.days.length === 1 && hist.days[0].came + hist.days[0].extra >= 2, '오늘 기록 요약');
    const csv = await (await fetch(base + '/api/attendance.csv?from=2000-01-01&to=2999-12-31', auth)).text();
    assert.ok(csv.includes('학번,이름') && csv.includes(a + ',Alex2'), '출석부 CSV');
    const stu = await (await fetch(base + '/api/student?id=' + a, auth)).json();
    assert.ok(stu.ok && stu.came === 1, '학생별 출석');
    const stats = await (await fetch(base + '/api/stats', auth)).json();
    assert.ok(stats.ok && typeof stats.days === 'number', '기간 통계');

    /* 백업 */
    const backup = await (await fetch(base + '/api/backup', auth)).json();
    assert.ok(backup.kind === 'study-room-kiosk-backup' && !backup.state.settings.pinHash, '백업에 PIN 해시 없음');

    /* PIN 바꾸기 */
    r = await post('/api/action', { type: 'change-pin', current: '0000', next: '5678', token });
    assert.ok(!r.result.ok, '지금 PIN이 틀리면 못 바꿈');
    r = await post('/api/action', { type: 'change-pin', current: '1234', next: '56789', token });
    assert.ok(r.result.ok && r.result.token && r.state.settings.pinLength === 5, 'PIN 바꾸기');
    assert.ok(!(await post('/api/action', { type: 'reset', token })).result.ok, '예전 세션은 끊김');
    token = r.result.token;

    r = await post('/api/action', { type: 'release', id: a });
    assert.ok(r.result.ok && r.result.seat === S2, '반납');
    r = await post('/api/action', { type: 'reset', token });
    assert.ok(r.result.ok, '로그인하고 초기화');

    /* 복원 */
    const rr = await post('/api/restore', backup);
    assert.ok(!rr.ok, '복원은 로그인 필요');
    const rs = await (await fetch(base + '/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(backup) })).json();
    assert.ok(rs.ok && rs.state.seats[S2], '백업으로 되돌리기');

    /* 틀린 PIN을 계속 누르면 잠깐 막힘 */
    let locked = 0;
    for (let i = 0; i < 6; i++) { const x = await post('/api/login', { pin: '0001' }); if (x.wait) locked = x.wait; }
    assert.ok(locked > 0, 'PIN 여러 번 틀리면 기다리게 함');

    /* PIN 잊었을 때: data/reset-pin */
    srv.kill(); await wait(300);
    fs.writeFileSync(path.join(DATA, 'reset-pin'), '2468\n');
    srv = start(); await wait(700);
    assert.ok((await post('/api/login', { pin: '2468' })).ok, 'reset-pin으로 PIN 되돌리기');
    assert.ok(!fs.existsSync(path.join(DATA, 'reset-pin')), 'reset-pin 파일은 지워짐');

    for (const route of ['/admin', '/away', '/cards', '/me', '/admin.html']) {
      const r2 = await fetch(base + route);
      assert.ok(r2.status === 200 && (r2.headers.get('content-type') || '').startsWith('text/html'), route + ' 주소');
    }
    assert.strictEqual((await fetch(base + '/nope')).status, 404, '없는 주소는 404');
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
