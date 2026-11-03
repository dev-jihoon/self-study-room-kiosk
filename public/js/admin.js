/* 감독 화면 */
(async function () {
  'use strict';
  const Core = window.KioskCore;
  const $ = (id) => document.getElementById(id);
  const store = await window.KioskStore.open();
  const layout = store.layout;
  const SERVER = store.mode === 'server';
  const AUTH_KEY = 'study-room-kiosk/auth';
  const RECENT_MS = 5 * 60 * 1000;
  let auth = '';            // 서버 모드: 세션 토큰, 브라우저 저장소 모드: PIN
  try { auth = sessionStorage.getItem(AUTH_KEY) || ''; } catch (e) {}
  let tab = 'map';
  let selected = null;      // 오른쪽에 보이는 학생
  let selectedSeat = null;  // 오른쪽에 보이는 빈자리
  let assigning = null;     // 자리를 정해 주는 중인 학생
  let logFilter = 'all';
  let lastActive = Date.now();

  document.querySelectorAll('[data-server]').forEach((el) => { el.hidden = !SERVER; });
  const gateHint = SERVER ? '' : '처음 PIN은 0000이에요';
  $('gate-hint').textContent = gateHint;

  /* 확대 막기: 두 손가락 확대, 두 번 탭 확대, ctrl+휠 */
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hm = (iso) => Core.hhmm(new Date(iso));
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const isSchoolId = (id) => /^\d{5}$/.test(String(id));
  const klass = (id) => isSchoolId(id) ? String(id)[0] + '학년 ' + Number(String(id).slice(1, 3)) + '반' : '그 밖의 학생';
  const fullClass = (id) => isSchoolId(id) ? klass(id) + ' ' + Number(String(id).slice(3, 5)) + '번' : '';
  const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
  function ago(iso) {
    const m = Math.floor((Date.now() - new Date(iso)) / 60000);
    if (m < 1) return '방금';
    if (m < 60) return m + '분 전';
    return Math.floor(m / 60) + '시간 전';
  }
  function length(min) { return min < 60 ? min + '분' : Math.floor(min / 60) + '시간 ' + (min % 60) + '분'; }

  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.className = 'toast is-show';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.className = 'toast'; }, 2600);
  }

  function ask(title, body, yesText, danger) {
    return new Promise((resolve) => {
      $('confirm-title').textContent = title;
      $('confirm-body').textContent = body || '';
      $('confirm-body').hidden = !body;
      const yes = $('confirm-yes');
      yes.textContent = yesText || '확인';
      yes.className = 'btn ' + (danger ? 'btn--danger' : 'btn--primary');
      $('confirm').classList.add('is-open');
      const done = (v) => { $('confirm').classList.remove('is-open'); yes.onclick = null; $('confirm-no').onclick = null; resolve(v); };
      yes.onclick = () => done(true);
      $('confirm-no').onclick = () => done(false);
    });
  }

  /* 여러 개 중 하나 고르기. options: [{value, label, sub?, custom?}] -> 고른 value (닫으면 null) */
  function choose(title, sub, options) {
    return new Promise((resolve) => {
      $('choose-title').textContent = title;
      $('choose-sub').textContent = sub || '';
      $('choose-sub').hidden = !sub;
      $('choose-custom').hidden = true;
      $('choose-input').value = '';
      $('choose-list').innerHTML = options.map((o, i) => '<button type="button" class="choice" data-i="' + i + '"><b>' + esc(o.label) + '</b>' + (o.sub ? '<span>' + esc(o.sub) + '</span>' : '') + '</button>').join('');
      $('choose').classList.add('is-open');
      const done = (v) => {
        $('choose').classList.remove('is-open');
        $('choose-list').onclick = null; $('choose-ok').onclick = null; $('choose-cancel').onclick = null; $('choose').onclick = null;
        resolve(v);
      };
      $('choose-list').onclick = (e) => {
        const b = e.target.closest('button[data-i]');
        if (!b) return;
        const o = options[Number(b.dataset.i)];
        if (o.custom) { $('choose-custom').hidden = false; $('choose-input').focus(); return; }
        done(o.value);
      };
      $('choose-ok').onclick = () => { const v = $('choose-input').value.trim(); if (v) done(v); else $('choose-input').focus(); };
      $('choose-cancel').onclick = () => done(null);
      $('choose').onclick = (e) => { if (e.target.id === 'choose') done(null); };
    });
  }

  /* ---------- 로그인 ---------- */
  const cred = () => (SERVER ? { token: auth } : { pin: auth });
  const pinLength = () => { const st = store.state.settings; return SERVER ? (st.pinLength || 4) : String(st.pin || '0000').length; };

  async function login(p) {
    if (!SERVER) return p === store.state.settings.pin ? { ok: true, auth: p } : { ok: false };
    try {
      const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: p }) });
      const j = await r.json();
      return j.ok ? { ok: true, auth: j.token } : { ok: false, wait: j.wait || 0 };
    } catch (e) { return { ok: false, offline: true }; }
  }
  async function stillIn() {
    if (!auth) return false;
    if (!SERVER) return auth === store.state.settings.pin;
    try { return (await (await fetch('api/session', { headers: { Authorization: 'Bearer ' + auth } })).json()).ok === true; } catch (e) { return false; }
  }
  function setAuth(v) {
    auth = v || '';
    try { if (auth) sessionStorage.setItem(AUTH_KEY, auth); else sessionStorage.removeItem(AUTH_KEY); } catch (e) {}
  }

  let pinBuf = '';
  let busy = false;
  let waitUntil = 0;
  function drawDots(el, n, filled, wrong) {
    el.innerHTML = Array.from({ length: Math.max(n, filled) }, (_, i) => '<i class="' + (i < filled ? 'is-on' : '') + '"></i>').join('');
    el.classList.toggle('is-wrong', !!wrong);
  }
  function drawGate(wrong) { drawDots($('dots'), pinLength(), pinBuf.length, wrong); }
  function lockCountdown() {
    const left = Math.ceil((waitUntil - Date.now()) / 1000);
    if (left <= 0) { $('gate-hint').textContent = gateHint; return; }
    $('gate-hint').textContent = '여러 번 틀렸어요. ' + left + '초 뒤에 다시 눌러 주세요';
    setTimeout(lockCountdown, 500);
  }
  async function pressPin(k) {
    if (busy || Date.now() < waitUntil) return;
    if (k === 'del') { pinBuf = pinBuf.slice(0, -1); drawGate(); return; }
    if (pinBuf.length >= pinLength()) return;
    pinBuf += k;
    drawGate();
    if (pinBuf.length < pinLength()) return;
    busy = true;
    const r = await login(pinBuf);
    busy = false;
    if (r.ok) { setAuth(r.auth); pinBuf = ''; openMain(); return; }
    drawGate(true);
    if (r.wait) { waitUntil = Date.now() + r.wait * 1000; lockCountdown(); }
    else $('gate-hint').textContent = r.offline ? '서버에 연결하지 못했어요' : 'PIN이 맞지 않아요';
    setTimeout(() => { pinBuf = ''; drawGate(); if (!r.wait) $('gate-hint').textContent = gateHint; }, 900);
  }
  $('pinpad').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) pressPin(b.dataset.k === 'del' ? 'del' : b.textContent);
  });
  document.addEventListener('keydown', (e) => {
    if (!$('gate').hidden && !e.target.closest('input, textarea')) {
      if (/^\d$/.test(e.key)) pressPin(e.key);
      else if (e.key === 'Backspace') pressPin('del');
    }
  });
  drawGate();

  function openMain() {
    $('gate').hidden = true;
    $('main').hidden = false;
    $('lock').hidden = false;
    lastActive = Date.now();
    fillSettings();
    render();
  }

  async function lock(message) {
    if (SERVER && auth) { try { await fetch('api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: auth }) }); } catch (e) {} }
    setAuth('');
    selected = null; selectedSeat = null; assigning = null;
    document.querySelectorAll('.sheet-wrap.is-open').forEach((x) => x.classList.remove('is-open'));
    $('main').hidden = true;
    $('lock').hidden = true;
    $('gate').hidden = false;
    pinBuf = '';
    drawGate();
    $('gate-hint').textContent = message || gateHint;
    window.scrollTo(0, 0);
  }
  $('lock').addEventListener('click', () => lock());

  /* 안 만지면 잠그기 */
  ['pointerdown', 'keydown', 'scroll'].forEach((ev) => document.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true }));
  setInterval(() => {
    const min = Number(store.state.settings.autoLockMin || 0);
    if (!$('main').hidden && min > 0 && Date.now() - lastActive > min * 60000) lock('오래 안 써서 잠갔어요');
  }, 15000);

  /* 감독 요청. 로그인이 풀렸으면 다시 잠근다 */
  async function act(action) {
    const r = await store.dispatch(Object.assign({}, cred(), action));
    if (r && r.auth) { lock('다시 로그인해 주세요'); return { ok: false, error: '다시 로그인해 주세요' }; }
    return r;
  }
  const teacher = (action) => act(Object.assign({ byTeacher: true }, action));

  /* 로그인이 필요한 서버 요청 (기록, 백업) */
  async function api(path, opts) {
    opts = opts || {};
    const r = await fetch(path, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + auth }, opts.headers || {}) }));
    if (r.status === 401) { lock('다시 로그인해 주세요'); throw new Error('auth'); }
    return r;
  }

  function saveBlob(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const csvCell = (v) => { v = String(v === undefined || v === null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const csvLine = (arr) => arr.map(csvCell).join(',');
  function download(name, text) { saveBlob(name, new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })); }
  async function downloadFrom(path, name) {
    try {
      const r = await api(path);
      if (!r.ok) { toast('내려받지 못했어요'); return; }
      saveBlob(name, await r.blob());
    } catch (e) { if (e.message !== 'auth') toast('서버에 연결하지 못했어요'); }
  }

  const dateShort = (k) => { const d = Core.dateOf(k); return (d.getMonth() + 1) + '/' + d.getDate() + '(' + Core.DAY_NAMES[d.getDay()] + ')'; };

  /* ---------- 탭 ---------- */
  function setTab(t) {
    tab = t;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('is-on', x.dataset.tab === t));
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('is-on', x.id === 't-' + t));
    if (t === 'settings') fillSettings();
    if (t === 'stats' && SERVER) loadHistory();
    render();
  }
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
  $('go-absent').addEventListener('click', () => setTab('absent'));

  function counts() {
    const st = store.state;
    const seated = new Set(Object.values(st.seats).map((s) => s.id));
    const excused = st.excused || {};
    const night = Core.appliedToday(st);
    const nightIds = new Set(night.map((s) => s.id));
    const absent = night.filter((s) => !seated.has(s.id) && !excused[s.id]);
    const excusedList = st.roster.filter((s) => excused[s.id]);
    const extra = st.roster.filter((s) => !nightIds.has(s.id) && seated.has(s.id));
    const out = Object.keys(st.seats).filter((k) => st.seats[k].out).map((k) => Object.assign({ seat: Number(k) }, st.seats[k]));
    const late = Object.values(st.seats).filter((x) => x.late);
    return { st, seated, night, nightIds, absent, excused: excusedList, extra, out, late };
  }

  function render() {
    if ($('main').hidden) return;
    const c = counts();
    const now = new Date();
    $('clock').textContent = Core.hhmm(now);
    $('today').textContent = (now.getMonth() + 1) + '월 ' + now.getDate() + '일 ' + '일월화수목금토'[now.getDay()] + '요일';
    renderSummary(c, now);
    if (tab === 'map') renderBoard(c);
    if (tab === 'absent') renderAbsent(c);
    if (tab === 'roster') renderRoster(c);
    if (tab === 'stats') renderStats(c, now);
    if (tab === 'settings') renderSettingsInfo();
  }

  function renderSummary(c, now) {
    const set = c.st.settings;
    const nowM = now.getHours() * 60 + now.getMinutes();
    const start = toMin(set.nightStart);
    let state;
    const off = Core.offDate(c.st, now);
    if (off) state = '오늘은 ' + (off.label ? off.label + '(이)라 ' : '') + '야자를 쉬어요';
    else if (!Core.isNightDay(c.st, now)) state = '오늘은 야자가 없는 날이에요';
    else if (Core.isNightTime(c.st, now)) state = '야자 중이에요. ' + set.nightEnd + '에 끝나요';
    else if (nowM < start) state = set.nightStart + '에 야자가 시작돼요';
    else state = '오늘 야자는 끝났어요';
    if (set.demoMode) state += ' (시연 모드)';
    $('run-state').textContent = state;
    const came = c.night.filter((s) => c.seated.has(s.id)).length;
    $('sum-title').innerHTML = '신청한 ' + c.night.length + '명 중 <b>' + came + '명</b>이 왔어요';
    $('meter').style.width = (c.night.length ? came / c.night.length * 100 : 0) + '%';
    const go = $('go-absent');
    go.textContent = c.absent.length ? '아직 안 온 학생 ' + c.absent.length + '명' : '신청한 학생이 모두 왔어요';
    go.classList.toggle('is-warn', c.absent.length > 0);
    const extra = [];
    if (c.excused.length) extra.push('못 오는 학생 ' + c.excused.length + '명');
    if (c.late.length) extra.push('지각 ' + c.late.length + '명');
    if (c.out.length) extra.push('외출 중 ' + c.out.length + '명');
    if (c.extra.length) extra.push('신청 안 하고 온 학생 ' + c.extra.length + '명');
    $('sum-extra').textContent = extra.join(', ');
  }

  /* ---------- 좌석 ---------- */
  function renderBoard(c) {
    const st = c.st;
    const selSeat = selected ? Core.seatOf(st, selected) : selectedSeat;
    const map = window.SeatMap.render($('map'), layout, st, {
      mode: 'admin',
      reserved: Core.reservations(st),
      decorate(el, no, occ) {
        if (no === selSeat) el.classList.add('is-selected');
        if (assigning && !occ && !Core.isClosed(st, no)) el.classList.add('is-target');
        if (occ && Date.now() - new Date(occ.at) < RECENT_MS) el.classList.add('is-new');
        if (occ && occ.late && !occ.out) { const t = document.createElement('span'); t.className = 'seat__tag seat__tag--late'; t.textContent = '지각'; el.appendChild(t); }
      },
      onSeat(no, occ) {
        if (assigning) {
          if (occ) { toast('이미 누가 앉아 있어요'); return; }
          if (Core.isClosed(st, no)) { toast('막아 둔 자리예요'); return; }
          doAssign(assigning, no);
          return;
        }
        selected = occ ? occ.id : null;
        selectedSeat = occ ? null : (selectedSeat === no ? null : no);
        render();
      }
    });
    requestAnimationFrame(() => window.SeatMap.fit($('map'), map, 1.3));
    $('assign-bar').hidden = !assigning;
    if (assigning) {
      const s = Core.findStudent(st, assigning);
      $('assign-text').textContent = (s ? s.name + '님' : '') + ' 자리를 배치도에서 골라 주세요';
    }
    renderDetail(st);
    renderFeed(st);
  }

  function actionButtons(box, list) {
    const row = document.createElement('div');
    row.className = 'btn-grid';
    list.forEach(([text, cls, fn]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + (cls || '');
      b.textContent = text;
      b.onclick = fn;
      row.appendChild(b);
    });
    box.appendChild(row);
  }

  /* 학생별 최근 출석 (서버 모드). 학생마다 1분 동안 저장해 둔다 */
  const histCache = new Map();
  async function studentHistory(id) {
    const hit = histCache.get(id);
    if (hit && Date.now() - hit.at < 60000) return hit.data;
    const r = await api('api/student?id=' + encodeURIComponent(id) + '&days=28');
    const data = await r.json();
    histCache.set(id, { at: Date.now(), data });
    return data;
  }
  function drawHistory(box, h) {
    const icon = { came: 'O', early: '조', absent: 'X', excused: '사' };
    box.innerHTML = '<div class="hist__h">최근 4주 <b>' + h.came + '일 출석</b>' + (h.absent ? ', 결석 ' + h.absent + '일' : '') + (h.excused ? ', 이유 있는 결석 ' + h.excused + '일' : '') + '</div>'
      + (h.days.length ? '<div class="hist__dots">' + h.days.slice(0, 20).reverse().map((d) => '<span class="hd hd--' + d.status + '" title="' + d.day + (d.reason ? ' ' + esc(d.reason) : '') + '">' + icon[d.status] + '<small>' + Number(d.day.slice(8)) + '</small></span>').join('') + '</div>' : '<p class="muted">아직 기록이 없어요</p>');
  }

  async function excuseFlow(stu) {
    const opts = Core.REASONS.map((r) => ({ value: r, label: r })).concat({ value: '', label: '직접 적을게요', custom: true });
    const reason = await choose(stu.name + '님은 왜 못 오나요?', '이유가 있으면 결석과 따로 세요', opts);
    if (!reason) return;
    const r = await teacher({ type: 'excuse', id: stu.id, reason });
    toast(r.ok ? stu.name + '님을 ' + reason + '(으)로 적었어요' : r.error);
  }

  function renderDetail(st) {
    const box = $('detail');
    const stu = selected ? Core.findStudent(st, selected) : null;
    $('feed-box').hidden = !!(stu || selectedSeat);
    box.innerHTML = '';
    box.className = '';
    if (!stu && selectedSeat) { renderSeatDetail(st, box); return; }
    if (!stu) return;
    box.className = 'detail';
    const seat = Core.seatOf(st, stu.id);
    const occ = seat !== null ? st.seats[seat] : null;
    const exc = (st.excused || {})[stu.id];
    const hist = st.log.filter((l) => l.id === stu.id);
    const todayApplied = Core.applied(stu, Core.dateOf(st.day));
    const rows = [['자리', seat !== null ? seat + '번' + (occ.out ? ' (외출 중)' : '') : exc ? '못 와요 (' + esc(exc.reason) + (exc.by === 'student' ? ', 학생이 알림' : '') + ')' : todayApplied ? '아직 안 왔어요' : '오늘은 신청 안 했어요']];
    const plans = (st.planned || []).filter((p) => p.id === stu.id);
    if (plans.length) rows.push(['미리 알림', plans.map((p) => dateShort(p.date) + ' ' + esc(p.reason)).join(', ')]);
    if (occ) {
      rows.push(['들어온 시각', hm(occ.at) + (occ.late ? ' (지각)' : '')]);
      rows.push(['있었던 시간', length(Math.floor((Date.now() - new Date(occ.at)) / 60000))]);
      if (occ.out) rows.push(['나간 시각', hm(occ.out)]);
    }
    rows.push(['신청 요일', Core.daysText(stu.days, st.settings.days)]);
    if (stu.seat) rows.push(['지정석', stu.seat + '번']);
    const sub = [fullClass(stu.id), '학번 ' + stu.id].filter(Boolean).join(', ');
    box.innerHTML =
      '<div class="detail__top"><div><div class="detail__name">' + esc(stu.name) + '</div><div class="detail__sub">' + sub + '</div></div>'
      + '<button type="button" class="detail__close" id="detail-close">닫기</button></div>'
      + '<dl class="detail__rows">' + rows.map((r) => '<div><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>').join('') + '</dl>'
      + (hist.length ? '<ol class="detail__hist">' + hist.slice(0, 5).map((l) => '<li><time>' + hm(l.at) + '</time>' + logText(l) + '</li>').join('') + '</ol>' : '')
      + (SERVER ? '<div class="hist" id="detail-hist"></div>' : '');
    $('detail-close').onclick = () => { selected = null; render(); };
    if (SERVER) {
      const id = stu.id;
      studentHistory(id).then((h) => { const el = $('detail-hist'); if (el && selected === id && h.ok) drawHistory(el, h); }).catch(() => {});
    }
    const edit = ['정보 고치기', '', () => openStudent(stu.id)];
    if (seat === null) {
      const fixedFree = stu.seat && !st.seats[stu.seat] && !Core.isClosed(st, stu.seat);
      const list = [];
      if (fixedFree) list.push([stu.seat + '번에 앉히기', 'btn--primary', () => doAssign(stu.id, stu.seat)]);
      list.push(['자리 정해 주기', fixedFree ? '' : 'btn--primary', () => startAssign(stu.id)]);
      if (exc) list.push(['못 와요 취소', '', async () => { const r = await act({ type: 'unexcuse', id: stu.id }); toast(r.ok ? '취소했어요' : r.error); }]);
      else list.push(['못 온다고 적기', '', () => excuseFlow(stu)]);
      list.push(edit);
      actionButtons(box, list);
      return;
    }
    actionButtons(box, [
      ['자리 옮기기', '', () => startAssign(stu.id)],
      occ.out
        ? ['돌아왔어요', 'btn--primary', async () => { const r = await teacher({ type: 'back', id: stu.id }); toast(r.ok ? stu.name + '님이 돌아왔어요' : r.error); }]
        : ['외출', '', async () => { const r = await teacher({ type: 'out', id: stu.id }); toast(r.ok ? stu.name + '님을 외출로 표시했어요' : r.error); }],
      ['조퇴', '', async () => {
        if (!(await ask(stu.name + '님을 조퇴로 처리할까요?', seat + '번이 빈자리가 되고, 기록에 조퇴로 남아요', '조퇴 처리할게요'))) return;
        const r = await teacher({ type: 'release', id: stu.id, reason: 'early' });
        toast(r.ok ? stu.name + '님을 조퇴로 처리했어요' : r.error);
      }],
      ['반납', 'btn--danger', async () => {
        if (!(await ask(stu.name + '님 자리를 반납할까요?', seat + '번이 빈자리가 돼요', '반납할게요', true))) return;
        const r = await teacher({ type: 'release', id: stu.id });
        toast(r.ok ? seat + '번을 반납했어요' : r.error);
      }]
    ]);
  }

  function renderSeatDetail(st, box) {
    const no = selectedSeat;
    const closed = Core.isClosed(st, no);
    const owner = !closed ? Core.reservedBy(st, no) : null;
    const owners = st.roster.filter((x) => x.seat === no);
    box.className = 'detail';
    if (owner) {
      box.innerHTML = '<div class="detail__top"><div><div class="detail__name">' + no + '번 자리</div><div class="detail__sub">' + esc(owner.name) + '님 지정석이에요. 아직 안 왔어요</div></div>'
        + '<button type="button" class="detail__close" id="detail-close">닫기</button></div>';
      $('detail-close').onclick = () => { selectedSeat = null; render(); };
      actionButtons(box, [
        [owner.name + '님 보기', 'btn--primary', () => { selected = owner.id; selectedSeat = null; render(); }],
        ['이 자리 막기', '', async () => { const r = await act({ type: 'seat-close', seat: no, closed: true }); toast(r.ok ? no + '번을 막았어요' : r.error); }]
      ]);
      return;
    }
    box.innerHTML = '<div class="detail__top"><div><div class="detail__name">' + no + '번 자리</div><div class="detail__sub">' + (closed ? '막아 둔 자리예요' : '비어 있어요') + '</div></div>'
      + '<button type="button" class="detail__close" id="detail-close">닫기</button></div>'
      + '<p class="detail__note">' + (closed ? '다시 열면 키오스크에서 고를 수 있어요' : '책상이 고장 났을 때처럼 못 쓰는 자리는 막아 둘 수 있어요') + '</p>'
      + (owners.length ? '<p class="detail__note">지정석 주인: ' + owners.map((x) => esc(x.name) + ' (' + Core.daysText(x.days, st.settings.days) + ')').join(', ') + '</p>' : '');
    $('detail-close').onclick = () => { selectedSeat = null; render(); };
    actionButtons(box, [[closed ? '다시 열기' : '이 자리 막기', closed ? 'btn--primary' : '', async () => {
      const r = await act({ type: 'seat-close', seat: no, closed: !closed });
      toast(r.ok ? no + '번을 ' + (closed ? '다시 열었어요' : '막았어요') : r.error);
    }]]);
  }

  function logText(l) {
    const who = l.by === 'teacher' ? ' (감독)' : '';
    if (l.type === 'move') return (l.from ? l.from + '번에서 ' : '') + l.seat + '번으로 옮겼어요' + who;
    if (l.type === 'release') return l.note === 'early' ? '조퇴했어요' + who : l.note === 'auto' ? '끝나서 ' + l.seat + '번을 자동으로 반납했어요' : l.seat + '번을 반납했어요' + who;
    if (l.type === 'excuse') return (l.by === 'student' ? '못 온다고 알렸어요' : '못 오는 학생으로 적었어요') + ' (' + esc(l.note || '') + ')';
    if (l.type === 'assign' && l.note === 'late') return l.seat + '번에 앉았어요 (지각)' + who;
    if (l.type === 'out') return '외출했어요' + who;
    if (l.type === 'back') return '외출에서 돌아왔어요' + who;
    return l.seat + '번에 앉았어요' + who;
  }

  function renderFeed(st) {
    const items = st.log.slice(0, 7);
    $('feed').innerHTML = items.length
      ? items.map((l) => '<li><button type="button" data-id="' + l.id + '"><b>' + esc(l.name) + '</b>' + logText(l) + '</button><time>' + ago(l.at) + '</time></li>').join('')
      : '<li class="feed__empty">아직 아무도 안 왔어요</li>';
  }
  $('feed').addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (b) { selected = b.dataset.id; selectedSeat = null; render(); } });

  function startAssign(id) {
    assigning = id;
    selected = id;
    selectedSeat = null;
    if (tab !== 'map') setTab('map'); else render();
  }
  $('assign-cancel').addEventListener('click', () => { assigning = null; render(); });
  async function doAssign(id, seat) {
    const r = await teacher({ type: 'assign', id, seat });
    if (!r.ok) { toast(r.error); return; }
    assigning = null;
    selected = id;
    toast(r.student.name + '님을 ' + seat + '번에 ' + (r.moved ? '옮겼어요' : '앉혔어요'));
    render();
  }

  /* 찾기 */
  function matches(s, q) { return s.id.includes(q) || s.name.toLowerCase().includes(q); }
  $('search').addEventListener('input', () => {
    const q = $('search').value.trim().toLowerCase();
    const ul = $('results');
    if (!q) { ul.innerHTML = ''; return; }
    const st = store.state;
    const hits = st.roster.filter((s) => matches(s, q)).slice(0, 8);
    ul.innerHTML = hits.length
      ? hits.map((s) => { const seat = Core.seatOf(st, s.id); return '<li><button type="button" data-id="' + s.id + '"><span>' + esc(s.name) + '<small>' + s.id + '</small></span><span class="tag' + (seat === null ? ' tag--off' : '') + '">' + (seat !== null ? seat + '번' : '안 왔어요') + '</span></button></li>'; }).join('')
      : '<li class="results__none">찾는 학생이 없어요</li>';
  });
  $('results').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    selected = b.dataset.id;
    selectedSeat = null;
    $('search').value = '';
    $('results').innerHTML = '';
    render();
  });

  /* ---------- 안 온 학생 ---------- */
  function renderAbsent(c) {
    $('absent-title').textContent = c.absent.length ? '아직 안 온 학생 ' + c.absent.length + '명' : '신청한 학생이 모두 왔어요';
    const groups = new Map();
    c.absent.forEach((s) => { const k = klass(s.id); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
    $('absent-classes').innerHTML = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((k) =>
      '<div class="class-card"><div class="class-card__h">' + k + '<span>' + groups.get(k).length + '명</span></div><div class="chips">'
      + groups.get(k).map((s) => '<button type="button" class="chip-btn" data-id="' + s.id + '" data-act="absent">' + esc(s.name) + (isSchoolId(s.id) ? '<small>' + Number(s.id.slice(3)) + '번</small>' : '') + '</button>').join('')
      + '</div></div>').join('');
    const ex = c.st.excused || {};
    $('excused-head').hidden = $('excused-card').hidden = !c.excused.length;
    $('excused-list').innerHTML = c.excused.map((s) => '<button type="button" class="chip-btn' + (ex[s.id].by === 'student' ? ' chip-btn--student' : '') + '" data-id="' + s.id + '" data-act="excused">' + esc(s.name) + '<small>' + esc(ex[s.id].reason) + (ex[s.id].by === 'student' ? ', 학생이 알림' : '') + '</small></button>').join('');
    const plans = c.st.planned || [];
    $('planned-head').hidden = $('planned-card').hidden = !plans.length;
    $('planned-list').innerHTML = plans.map((p) => '<li><span class="planned__d">' + dateShort(p.date) + '</span><span><b>' + esc(p.name) + '</b> <small>' + p.id + '</small></span><span class="muted">' + esc(p.reason) + (p.by === 'student' ? ', 학생이 알림' : '') + '</span>'
      + '<button type="button" class="btn btn--small btn--ghost" data-plan-id="' + p.id + '" data-plan-date="' + p.date + '">취소</button></li>').join('');
    $('out-head').hidden = !c.out.length;
    $('out-list').parentElement.hidden = !c.out.length;
    $('out-list').innerHTML = c.out.map((s) => '<button type="button" class="chip-btn" data-id="' + s.id + '" data-view="1">' + esc(s.name) + '<small>' + s.seat + '번, ' + ago(s.out) + '</small></button>').join('');
    $('extra-list').innerHTML = c.extra.length
      ? c.extra.map((s) => '<button type="button" class="chip-btn" data-id="' + s.id + '" data-view="1">' + esc(s.name) + '<small>' + Core.seatOf(c.st, s.id) + '번</small></button>').join('')
      : '<p class="empty">없어요</p>';
  }
  $('t-absent').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-id], button[data-plan-id]');
    if (!b) return;
    if (b.dataset.view) { selected = b.dataset.id; selectedSeat = null; setTab('map'); return; }
    const st = store.state;
    if (b.dataset.planId) {
      if (!(await ask(dateShort(b.dataset.planDate) + ' 알림을 취소할까요?', '그날 안 오면 결석으로 세요', '취소할게요'))) return;
      const r = await teacher({ type: 'absence-cancel', id: b.dataset.planId, date: b.dataset.planDate });
      toast(r.ok ? '알림을 취소했어요' : r.error);
      return;
    }
    const stu = Core.findStudent(st, b.dataset.id);
    if (!stu) return;
    if (b.dataset.act === 'excused') {
      const v = await choose(stu.name + '님', (st.excused[stu.id] || {}).reason + '(으)로 ' + ((st.excused[stu.id] || {}).by === 'student' ? '학생이 알렸어요' : '적어 뒀어요'), [
        { value: 'undo', label: '못 와요 취소하기', sub: '다시 안 온 학생으로 돌아가요' },
        { value: 'seat', label: '자리 정해 주기' }
      ]);
      if (v === 'undo') { const r = await act({ type: 'unexcuse', id: stu.id }); toast(r.ok ? '취소했어요' : r.error); }
      if (v === 'seat') startAssign(stu.id);
      return;
    }
    const fixedFree = stu.seat && !st.seats[stu.seat] && !Core.isClosed(st, stu.seat);
    const opts = [];
    if (fixedFree) opts.push({ value: 'fixed', label: stu.seat + '번 지정석에 앉히기' });
    opts.push({ value: 'seat', label: '자리 정해 주기', sub: '배치도에서 골라요' });
    opts.push({ value: 'excuse', label: '못 온다고 적기', sub: Core.REASONS.join(', ') + ' 등' });
    const v = await choose(stu.name + '님을 어떻게 할까요?', fullClass(stu.id), opts);
    if (v === 'fixed') doAssign(stu.id, stu.seat);
    else if (v === 'seat') startAssign(stu.id);
    else if (v === 'excuse') excuseFlow(stu);
  });

  /* ---------- 명단 ---------- */
  const PAGE = 150;
  let rosterLimit = PAGE;
  const nightDays = () => { const d = store.state.settings.days; return (Array.isArray(d) && d.length ? d : [1, 2, 3, 4, 5]).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); };
  function rosterFilter() {
    const st = store.state;
    const q = $('r-q').value.trim().toLowerCase();
    const g = $('r-grade').value, k = $('r-class').value, n = $('r-night').value;
    const today = Core.dateOf(st.day);
    return st.roster.filter((s) => {
      if (q && !matches(s, q)) return false;
      if (g && !(isSchoolId(s.id) && s.id[0] === g)) return false;
      if (k && !(isSchoolId(s.id) && s.id.slice(1, 3) === k)) return false;
      if (n === 'today' && !Core.applied(s, today)) return false;
      if (n === 'any' && !nightDays().some((d) => s.days.indexOf(d) !== -1)) return false;
      if (n === 'none' && nightDays().some((d) => s.days.indexOf(d) !== -1)) return false;
      if (n === 'fixed' && !s.seat) return false;
      if (/^d\d$/.test(n) && s.days.indexOf(Number(n[1])) === -1) return false;
      return true;
    });
  }
  function fillRosterFilters() {
    const st = store.state;
    const grades = [...new Set(st.roster.filter((s) => isSchoolId(s.id)).map((s) => s.id[0]))].sort();
    const g = $('r-grade').value;
    $('r-grade').innerHTML = '<option value="">학년 전체</option>' + grades.map((x) => '<option value="' + x + '">' + x + '학년</option>').join('');
    $('r-grade').value = grades.indexOf(g) !== -1 ? g : '';
    const gg = $('r-grade').value;
    const classes = [...new Set(st.roster.filter((s) => isSchoolId(s.id) && (!gg || s.id[0] === gg)).map((s) => s.id.slice(1, 3)))].sort();
    const k = $('r-class').value;
    $('r-class').innerHTML = '<option value="">반 전체</option>' + classes.map((x) => '<option value="' + x + '">' + Number(x) + '반</option>').join('');
    $('r-class').value = classes.indexOf(k) !== -1 ? k : '';
    const n = $('r-night').value;
    const nOpts = [['', '신청 전체'], ['today', '오늘 신청한 학생'], ['any', '한 요일이라도 신청']].concat(nightDays().map((d) => ['d' + d, Core.DAY_NAMES[d] + '요일 신청']), [['none', '신청 안 한 학생'], ['fixed', '지정석 있는 학생']]);
    $('r-night').innerHTML = nOpts.map(([v, t]) => '<option value="' + v + '">' + t + '</option>').join('');
    $('r-night').value = nOpts.some(([v]) => v === n) ? n : '';
    const bd = $('r-bulk-day').value;
    $('r-bulk-day').innerHTML = '<option value="all">모든 요일</option>' + nightDays().map((d) => '<option value="' + d + '">' + Core.DAY_NAMES[d] + '요일</option>').join('');
    $('r-bulk-day').value = bd && [...$('r-bulk-day').options].some((o) => o.value === bd) ? bd : 'all';
  }
  function dayChips(s) {
    return '<div class="minidays">' + nightDays().map((d) => '<button type="button" data-day="' + d + '" data-sid="' + s.id + '" class="' + (s.days.indexOf(d) !== -1 ? 'is-on' : '') + '" aria-label="' + Core.DAY_NAMES[d] + '요일">' + Core.DAY_NAMES[d] + '</button>').join('') + '</div>';
  }
  function renderRoster(c) {
    const st = c.st;
    fillRosterFilters();
    const any = st.roster.filter((s) => nightDays().some((d) => s.days.indexOf(d) !== -1)).length;
    $('roster-sum').textContent = '모두 ' + st.roster.length + '명, 야자 신청 ' + any + '명, 오늘 신청 ' + c.night.length + '명';
    const list = rosterFilter();
    const shown = list.slice(0, rosterLimit);
    const seats = new Map(Object.keys(st.seats).map((k) => [st.seats[k].id, Number(k)]));
    $('r-body').innerHTML = shown.length ? shown.map((s) => {
      const seat = seats.get(s.id);
      const ex = (st.excused || {})[s.id];
      return '<tr><td class="num">' + s.id + '</td><td>' + esc(s.name) + '</td><td>' + dayChips(s) + '</td>'
        + '<td class="num">' + (s.seat ? s.seat + '번' : '<span class="muted">없음</span>') + '</td>'
        + '<td>' + (seat !== undefined ? '<button type="button" class="btn btn--small btn--ghost" data-show="' + s.id + '">' + seat + '번</button>'
          : ex ? '<span class="muted">' + esc(ex.reason) + '</span> <button type="button" class="btn btn--small btn--ghost" data-assign="' + s.id + '">정해 주기</button>'
          : '<button type="button" class="btn btn--small btn--ghost" data-assign="' + s.id + '">정해 주기</button>') + '</td>'
        + '<td class="t-r"><button type="button" class="btn btn--small btn--ghost" data-edit="' + s.id + '">고치기</button></td></tr>';
    }).join('') : '<tr><td colspan="6" class="empty-row">찾는 학생이 없어요</td></tr>';
    $('r-more').innerHTML = list.length > shown.length ? '<button type="button" class="btn btn--small" id="r-more-btn">' + (list.length - shown.length) + '명 더 보기</button>' : '';
    const filtered = list.length !== st.roster.length;
    $('r-bulk').hidden = !filtered || !list.length;
    $('r-bulk-text').textContent = '찾은 ' + list.length + '명을';
  }
  ['r-q', 'r-grade', 'r-class', 'r-night'].forEach((id) => $(id).addEventListener(id === 'r-q' ? 'input' : 'change', () => {
    if (id === 'r-grade') $('r-class').value = '';
    rosterLimit = PAGE;
    render();
  }));
  $('r-more').addEventListener('click', (e) => { if (e.target.id === 'r-more-btn') { rosterLimit += PAGE * 2; render(); } });
  $('r-body').addEventListener('click', async (e) => {
    const dayBtn = e.target.closest('button[data-day]');
    if (dayBtn) {
      const s = Core.findStudent(store.state, dayBtn.dataset.sid);
      if (!s) return;
      const d = Number(dayBtn.dataset.day);
      const on = s.days.indexOf(d) === -1;
      dayBtn.classList.toggle('is-on', on);
      const r = await act({ type: 'days-set', ids: [s.id], mode: on ? 'add' : 'remove', day: d });
      if (!r.ok) { dayBtn.classList.toggle('is-on', !on); toast(r.error); }
      return;
    }
    const asg = e.target.closest('button[data-assign]');
    if (asg) { startAssign(asg.dataset.assign); window.scrollTo(0, 0); return; }
    const shw = e.target.closest('button[data-show]');
    if (shw) { selected = shw.dataset.show; selectedSeat = null; setTab('map'); window.scrollTo(0, 0); return; }
    const b = e.target.closest('button[data-edit]');
    if (b) openStudent(b.dataset.edit);
  });
  async function bulkNight(on) {
    const ids = rosterFilter().map((s) => s.id);
    const v = $('r-bulk-day').value;
    const what = v === 'all' ? (on ? '매일 신청으로' : '신청 안 함으로') : Core.DAY_NAMES[Number(v)] + '요일을 ' + (on ? '신청으로' : '신청 취소로');
    if (!(await ask(ids.length + '명을 ' + what + ' 바꿀까요?', '', '바꿀게요'))) return;
    const action = v === 'all' ? { type: 'days-set', ids, mode: on ? 'all' : 'none' } : { type: 'days-set', ids, mode: on ? 'add' : 'remove', day: Number(v) };
    const r = await act(action);
    toast(r.ok ? r.count + '명을 바꿨어요' : r.error);
  }
  $('r-night-on').addEventListener('click', () => bulkNight(true));
  $('r-night-off').addEventListener('click', () => bulkNight(false));
  $('r-del').addEventListener('click', async () => {
    const ids = rosterFilter().map((s) => s.id);
    if (!(await ask(ids.length + '명을 명단에서 지울까요?', '앉아 있는 학생은 자리도 비워져요. 지운 뒤에는 되돌릴 수 없어요', ids.length + '명 지울게요', true))) return;
    const r = await act({ type: 'student-delete', ids });
    toast(r.ok ? r.count + '명을 지웠어요' : r.error);
  });

  /* 학생 더하기, 고치기 */
  let editing = null;
  let stuDays = [];
  function drawStuDays() {
    $('stu-days').innerHTML = nightDays().map((d) => '<button type="button" data-d="' + d + '" class="' + (stuDays.indexOf(d) !== -1 ? 'is-on' : '') + '">' + Core.DAY_NAMES[d] + '</button>').join('');
  }
  $('stu-days').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = Number(b.dataset.d);
    stuDays = stuDays.indexOf(d) !== -1 ? stuDays.filter((x) => x !== d) : stuDays.concat(d).sort();
    drawStuDays();
  });
  function openStudent(id) {
    const s = id ? Core.findStudent(store.state, id) : null;
    editing = s ? s.id : null;
    $('stu-title').textContent = s ? s.name + '님 정보' : '어떤 학생을 더할까요?';
    $('stu-id').value = s ? s.id : '';
    $('stu-id').readOnly = !!s;
    $('stu-name').value = s ? s.name : '';
    stuDays = s ? s.days.slice() : nightDays().slice();
    drawStuDays();
    $('stu-seat').value = s && s.seat ? s.seat : '';
    $('stu-del').hidden = !s;
    $('stu-err').textContent = '';
    $('stu').classList.add('is-open');
    setTimeout(() => (s ? $('stu-name') : $('stu-id')).focus(), 50);
  }
  function closeStudent() { $('stu').classList.remove('is-open'); editing = null; render(); }
  $('r-add').addEventListener('click', () => openStudent(null));
  $('stu-cancel').addEventListener('click', closeStudent);
  $('stu').addEventListener('click', (e) => { if (e.target.id === 'stu') closeStudent(); });
  $('stu-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const seatText = $('stu-seat').value.trim().replace(/번$/, '');
    const student = { id: $('stu-id').value.trim(), name: $('stu-name').value.trim(), days: stuDays, seat: seatText };
    if (seatText && Core.allSeatNumbers(layout).indexOf(Number(seatText)) === -1) { $('stu-err').textContent = seatText + '번은 없는 자리예요'; return; }
    const err = Core.checkStudent(student);
    if (err) { $('stu-err').textContent = err; return; }
    const r = await act({ type: 'student-save', isNew: !editing, student });
    if (!r.ok) { $('stu-err').textContent = r.error; return; }
    toast(editing ? '저장했어요' : student.name + '님을 더했어요');
    closeStudent();
  });
  $('stu-del').addEventListener('click', async () => {
    const s = Core.findStudent(store.state, editing);
    if (!s) return;
    $('stu').classList.remove('is-open');
    if (!(await ask(s.name + '님을 명단에서 지울까요?', Core.seatOf(store.state, s.id) !== null ? '지금 앉은 자리도 비워져요' : '', '지울게요', true))) { $('stu').classList.add('is-open'); return; }
    const r = await act({ type: 'student-delete', ids: [s.id] });
    toast(r.ok ? s.name + '님을 지웠어요' : r.error);
    editing = null;
  });

  /* 명단 불러오기 */
  let parsed = null;
  function impStep(name) {
    $('imp-pick').hidden = name !== 'pick';
    $('imp-how').hidden = name !== 'how';
  }
  function openImport() {
    parsed = null;
    $('imp-paste').value = '';
    impStep('pick');
    $('imp').classList.add('is-open');
  }
  function closeImport() { $('imp').classList.remove('is-open'); parsed = null; }
  $('r-import').addEventListener('click', openImport);
  $('imp').addEventListener('click', (e) => { if (e.target.id === 'imp' || e.target.closest('[data-close]')) closeImport(); });
  $('imp-back').addEventListener('click', () => impStep('pick'));
  $('imp-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { showParsed(Core.rosterFromTable(await window.TableFile.read(f)), f.name); }
    catch (err) { toast(err.message || '파일을 읽지 못했어요'); }
  });
  $('imp-read').addEventListener('click', () => {
    const text = $('imp-paste').value;
    if (!text.trim()) { toast('표를 붙여 넣어 주세요'); return; }
    showParsed(Core.rosterFromTable(Core.parseCsv(text)), '');
  });
  /* 파일을 끌어다 놓아도 된다 (PC에서) */
  $('imp-drop').addEventListener('dragover', (e) => { e.preventDefault(); $('imp-drop').classList.add('is-over'); });
  $('imp-drop').addEventListener('dragleave', () => $('imp-drop').classList.remove('is-over'));
  $('imp-drop').addEventListener('drop', async (e) => {
    e.preventDefault();
    $('imp-drop').classList.remove('is-over');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    try { showParsed(Core.rosterFromTable(await window.TableFile.read(f)), f.name); }
    catch (err) { toast(err.message || '파일을 읽지 못했어요'); }
  });

  function showParsed(res, fileName) {
    if (!res.rows.length) {
      toast(res.problems.length ? '읽을 수 있는 학생이 없어요. ' + res.problems[0].text : '읽을 수 있는 학생이 없어요. 학번 칸이 있는지 확인해 주세요');
      return;
    }
    parsed = res;
    const st = store.state;
    const cur = new Map(st.roster.map((s) => [s.id, s]));
    const ids = new Set(res.rows.map((s) => s.id));
    const added = res.rows.filter((s) => !cur.has(s.id)).length;
    const differs = (s) => {
      const c = cur.get(s.id);
      if (c.name !== s.name) return true;
      if (s.days && s.days.join() !== c.days.join()) return true;
      if (s.seat !== undefined && Number(s.seat || 0) !== Number(c.seat || 0)) return true;
      return false;
    };
    const changed = res.rows.filter((s) => cur.has(s.id) && res.hasName && differs(s)).length;
    const removed = st.roster.filter((s) => !ids.has(s.id)).length;
    const unknown = res.rows.filter((s) => !cur.has(s.id)).length;
    $('imp-title').textContent = (fileName ? fileName + '에서 ' : '') + res.rows.length + '명을 읽었어요';
    $('imp-problems').innerHTML = res.problems.length
      ? '<b>' + res.problems.length + '줄은 빼고 불러와요</b><ul>' + res.problems.slice(0, 30).map((p) => '<li><span>' + p.line + '번째 줄</span>' + esc(p.text) + '</li>').join('') + (res.problems.length > 30 ? '<li>그 밖에 ' + (res.problems.length - 30) + '줄</li>' : '') + '</ul>'
      : '';
    const cols = ['학번'].concat(res.hasName ? ['이름'] : [], res.hasDays ? ['신청 요일'] : [], res.hasSeat ? ['지정석'] : []);
    $('imp-preview').innerHTML = '<thead><tr>' + cols.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>'
      + res.rows.slice(0, 5).map((s) => '<tr><td class="num">' + s.id + '</td>' + (res.hasName ? '<td>' + esc(s.name) + '</td>' : '') + (res.hasDays ? '<td>' + Core.daysText(s.days, st.settings.days) + '</td>' : '') + (res.hasSeat ? '<td>' + (s.seat ? s.seat + '번' : '') + '</td>' : '') + '</tr>').join('')
      + (res.rows.length > 5 ? '<tr><td colspan="' + cols.length + '" class="muted">그 밖에 ' + (res.rows.length - 5) + '명</td></tr>' : '') + '</tbody>';
    const choices = [];
    const noName = '이름 칸이 없어서 고를 수 없어요';
    const mergeText = added && changed ? '새 학생 ' + added + '명을 더하고, 바뀐 ' + changed + '명을 고쳐요'
      : added ? '새 학생 ' + added + '명을 더해요' : changed ? '바뀐 ' + changed + '명을 고쳐요' : '바뀌는 학생이 없어요';
    choices.push({ mode: 'replace', title: '명단 전체 바꾸기', sub: res.hasName ? '지금 명단 ' + st.roster.length + '명을 이 ' + res.rows.length + '명으로 바꿔요' + (removed ? '. 파일에 없는 ' + removed + '명은 명단에서 빠져요' : '') : noName, off: !res.hasName });
    choices.push({ mode: 'merge', title: '지금 명단에 더하기', sub: res.hasName ? mergeText : noName, off: !res.hasName || (!added && !changed) });
    const known = res.rows.length - unknown;
    choices.push({ mode: 'night', title: '야자 신청만 바꾸기', sub: !known ? '지금 명단에 있는 학번이 없어요'
      : '이 ' + known + '명을 ' + (res.hasDays ? '파일에 적힌 요일로' : '매일') + ' 신청한 것으로 하고, 나머지는 신청 안 한 것으로 해요' + (unknown ? '. 명단에 없는 학번 ' + unknown + '명은 건너뛰어요' : ''), off: !known });
    $('imp-choices').innerHTML = choices.map((c) => '<button type="button" class="choice" data-mode="' + c.mode + '"' + (c.off ? ' disabled' : '') + '><b>' + c.title + '</b><span>' + esc(c.sub) + '</span></button>').join('');
    impStep('how');
  }
  $('imp-choices').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b || !parsed) return;
    const mode = b.dataset.mode;
    const rows = parsed.rows.map((s) => { const r = { id: s.id, name: s.name }; if (s.days) r.days = s.days; if (s.seat !== undefined) r.seat = s.seat; return r; });
    const title = { replace: '명단을 ' + rows.length + '명으로 바꿀까요?', merge: '지금 명단에 더할까요?', night: '야자 신청을 바꿀까요?' }[mode];
    $('imp').classList.remove('is-open');
    if (!(await ask(title, b.querySelector('span').textContent, '불러올게요'))) { $('imp').classList.add('is-open'); return; }
    const r = await act({ type: 'roster-import', mode, rows });
    if (!r.ok) { toast(r.error); $('imp').classList.add('is-open'); return; }
    parsed = null;
    if (mode === 'replace') toast('명단을 ' + r.count + '명으로 바꿨어요');
    else if (mode === 'merge') toast(r.added && r.changed ? r.added + '명을 더하고 ' + r.changed + '명을 고쳤어요' : r.added ? r.added + '명을 더했어요' : r.changed + '명을 고쳤어요');
    else toast('야자 신청을 ' + r.night + '명으로 바꿨어요');
    rosterLimit = PAGE;
    if (tab !== 'roster') setTab('roster');
  });

  /* 명단 파일 */
  const daysCell = (days) => { const t = Core.daysText(days, store.state.settings.days); return t === '신청 안 함' ? '' : t.replace(/, /g, ''); };
  $('r-export').addEventListener('click', () => {
    download('명단_' + store.state.day + '.csv', '학번,이름,신청요일,지정석\n' + store.state.roster.map((s) => csvLine([s.id, s.name, daysCell(s.days), s.seat || ''])).join('\n'));
  });
  $('r-template').addEventListener('click', () => {
    download('명단_양식.csv', '학번,이름,신청요일,지정석\n10101,Alex,매일,12\n10102,Ben,월수금,\n10103,Chloe,화목,\n10104,Daniel,,\n');
  });

  /* ---------- 기록 ---------- */
  function renderStats(c, now) {
    const st = c.st;
    const set = st.settings;
    const nowM = now.getHours() * 60 + now.getMinutes();
    const assigns = st.log.filter((l) => l.type === 'assign');
    let from = toMin(set.nightStart), to = from + 60;
    if (assigns.length) {
      const ms = assigns.map((l) => { const d = new Date(l.at); return d.getHours() * 60 + d.getMinutes(); });
      from = Math.floor(Math.min(...ms) / 10) * 10;
      to = Math.min(Math.max(Math.max(...ms) + 10, Math.min(nowM + 10, toMin(set.nightEnd))), from + 6 * 60);
    }
    const buckets = [];
    for (let m = Math.floor(from / 10) * 10; m < to; m += 10) buckets.push({ m, n: 0 });
    assigns.forEach((l) => { const d = new Date(l.at); const m = d.getHours() * 60 + d.getMinutes(); const b = buckets.find((x) => m >= x.m && m < x.m + 10); if (b) b.n += 1; });
    const max = Math.max(1, ...buckets.map((b) => b.n));
    const lab = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    $('timeline').innerHTML = buckets.map((b) => '<div class="bars__col"><span class="bars__n">' + (b.n || '') + '</span><div class="bars__bar' + (b.n ? '' : ' is-zero') + '" style="height:' + (b.n / max * 100) + '%"></div><span class="bars__t">' + (b.m % 30 === 0 ? lab(b.m) : '') + '</span></div>').join('');

    const cls = new Map();
    c.night.forEach((s) => { const k = klass(s.id); if (!cls.has(k)) cls.set(k, { n: 0, came: 0 }); const x = cls.get(k); x.n += 1; if (c.seated.has(s.id)) x.came += 1; });
    $('class-rates').innerHTML = cls.size ? [...cls.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((k) => {
      const x = cls.get(k);
      return '<li><span>' + (k.indexOf('학년') !== -1 ? k.replace('학년 ', '-').replace('반', '') + '반' : k) + '</span><div class="rates__bar"><span style="width:' + (x.came / x.n * 100) + '%"></span></div><span class="rates__n">' + x.came + ' / ' + x.n + '명</span></li>';
    }).join('') : '<li class="empty">야자 신청한 학생이 없어요</li>';

    const rows = st.log.filter((l) => logFilter === 'all' || l.type === logFilter || (logFilter === 'out' && l.type === 'back'));
    $('log-filter').querySelector('[data-f=excuse]').hidden = !st.log.some((l) => l.type === 'excuse');
    $('log').innerHTML = rows.length
      ? rows.slice(0, 300).map((l) => '<li><time>' + hm(l.at) + '</time><span><b>' + esc(l.name) + '</b><small>' + l.id + '</small> ' + logText(l).replace(' (감독)', '') + '</span><span class="by">' + ({ teacher: '감독', auto: '자동', student: '학생' }[l.by] || '키오스크') + '</span></li>').join('')
      : '<li><span></span><span class="empty">기록이 없어요</span></li>';
  }
  $('log-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    logFilter = b.dataset.f;
    document.querySelectorAll('#log-filter button').forEach((x) => x.classList.toggle('is-on', x === b));
    render();
  });

  /* 지난 기록 (서버 모드) */
  const dayLabel = (d) => { const x = new Date(d + 'T00:00:00'); return (x.getMonth() + 1) + '월 ' + x.getDate() + '일 ' + '일월화수목금토'[x.getDay()] + '요일'; };
  async function loadHistory() {
    if (!$('h-from').value) {
      const now = new Date();
      $('h-from').value = Core.todayKey(new Date(now.getFullYear(), now.getMonth(), 1));
      $('h-to').value = Core.todayKey(now);
    }
    try {
      const j = await (await api('api/history')).json();
      $('h-days').innerHTML = j.days.length ? j.days.slice(0, 60).map((d) =>
        '<li><span class="days__d">' + dayLabel(d.day) + (d.day === store.state.day ? ' <small>오늘</small>' : '') + '</span>'
        + '<span class="days__n">신청 ' + d.night + '명 중 ' + d.came + '명 출석' + (d.absent ? ', 결석 ' + d.absent + '명' : '') + (d.excused ? ', 못 오는 학생 ' + d.excused + '명' : '') + (d.late ? ', 지각 ' + d.late + '명' : '') + (d.early ? ', 조퇴 ' + d.early + '명' : '') + (d.extra ? ', 신청 안 하고 온 학생 ' + d.extra + '명' : '') + '</span>'
        + '<button type="button" class="btn btn--small" data-day="' + d.day + '">내려받기</button></li>').join('')
        : '<li class="empty">아직 지난 기록이 없어요. 야자가 끝난 다음 날부터 하루씩 쌓여요</li>';
    } catch (e) { if (e.message !== 'auth') $('h-days').innerHTML = '<li class="empty">기록을 불러오지 못했어요</li>'; }
  }
  $('h-days').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-day]');
    if (b) downloadFrom('api/history.csv?day=' + b.dataset.day, '야자기록_' + b.dataset.day + '.csv');
  });
  /* 기간 통계: 요일별, 반별 출석률과 결석이 많은 학생 */
  const pct = (a, b) => (b ? Math.round(a / b * 100) + '%' : '-');
  $('h-stats').addEventListener('click', async () => {
    const from = $('h-from').value, to = $('h-to').value;
    if (!from || !to || from > to) { toast('기간을 확인해 주세요'); return; }
    try {
      const j = await (await api('api/stats?from=' + from + '&to=' + to)).json();
      const box = $('h-pstats');
      box.hidden = false;
      if (!j.days) { box.innerHTML = '<p class="empty">이 기간에는 기록이 없어요</p>'; return; }
      const t = j.total;
      const rateRow = (label, x) => '<li><span>' + label + '</span><div class="rates__bar"><span style="width:' + (x.night ? x.came / x.night * 100 : 0) + '%"></span></div><span class="rates__n">' + pct(x.came, x.night) + '</span></li>';
      const dayRows = [1, 2, 3, 4, 5, 6, 0].filter((d) => j.byDay[d]).map((d) => rateRow(Core.DAY_NAMES[d] + '요일', j.byDay[d])).join('');
      const clsRows = Object.keys(j.byClass).sort().map((k) => rateRow(/^\d{3}$/.test(k) ? k[0] + '-' + Number(k.slice(1)) + '반' : k, j.byClass[k])).join('');
      box.innerHTML = '<div class="pstats__sum"><div><b>' + j.days + '일</b><span>기록한 날</span></div><div><b>' + pct(t.came, t.night) + '</b><span>출석률</span></div><div><b>' + t.absent + '번</b><span>결석</span></div><div><b>' + t.excused + '번</b><span>이유 있는 결석</span></div></div>'
        + '<div class="pstats__grid"><div><h4>요일별 출석률</h4><ul class="rates">' + dayRows + '</ul></div><div><h4>반별 출석률</h4><ul class="rates rates--scroll">' + clsRows + '</ul></div>'
        + '<div><h4>결석이 많은 학생</h4>' + (j.absentTop.length ? '<ol class="toplist">' + j.absentTop.map((x) => '<li><button type="button" data-id="' + x.id + '">' + esc(x.name) + '<small>' + x.id + '</small></button><span>' + x.n + '번</span></li>').join('') + '</ol>' : '<p class="empty">없어요</p>') + '</div></div>';
    } catch (e) { if (e.message !== 'auth') toast('통계를 불러오지 못했어요'); }
  });
  $('h-pstats').addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (b) { selected = b.dataset.id; selectedSeat = null; setTab('map'); } });
  $('h-csv').addEventListener('click', () => {
    const from = $('h-from').value, to = $('h-to').value;
    if (!from || !to || from > to) { toast('기간을 확인해 주세요'); return; }
    downloadFrom('api/attendance.csv?from=' + from + '&to=' + to, '야자출석부_' + from + '_' + to + '.csv');
  });

  /* 배치도 인쇄 */
  $('print-map').addEventListener('click', () => {
    $('main').dataset.printTitle = '자기주도학습실 좌석 ' + $('today').textContent + ' ' + Core.hhmm();
    selected = null; selectedSeat = null; assigning = null;
    render();
    setTimeout(() => window.print(), 100);
  });

  store.subscribe(() => { if (!document.querySelector('#stu.is-open, #imp.is-open, #pinx.is-open, #choose.is-open')) render(); });
  setInterval(render, 20000);

  /* ---------- 설정 ---------- */
  const DAY_NAMES = '일월화수목금토';
  let days = [];
  function drawDays() {
    $('f-days').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((d) => '<button type="button" data-d="' + d + '" class="' + (days.indexOf(d) !== -1 ? 'is-on' : '') + '">' + DAY_NAMES[d] + '</button>').join('');
  }
  $('f-days').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = Number(b.dataset.d);
    days = days.indexOf(d) !== -1 ? days.filter((x) => x !== d) : days.concat(d);
    drawDays();
  });
  function fillSettings() {
    const s = store.state.settings;
    $('f-start').value = s.nightStart;
    $('f-end').value = s.nightEnd;
    days = Array.isArray(s.days) ? s.days.slice() : [1, 2, 3, 4, 5];
    drawDays();
    $('f-demo').checked = !!s.demoMode;
    $('f-auto').checked = s.autoRelease !== false;
    $('f-fixed').checked = s.fixedOnly !== false;
    $('f-notice').value = s.notice || '';
    $('f-late').value = String(s.lateMin === undefined ? 10 : s.lateMin);
    if (!$('f-late').value) $('f-late').value = '10';
    drawAwayLink();
    drawOffDates();
    $('f-hook').value = s.webhookUrl || '';
    $('f-public').value = s.publicUrl || '';
    $('f-lock').value = String(s.autoLockMin === undefined ? 10 : s.autoLockMin);
    if (!$('f-lock').value) $('f-lock').value = '10';
    renderSettingsInfo();
  }
  /* 학생이 못 온다고 알리는 주소와 QR */
  function awayUrl() {
    const base = store.state.settings.publicUrl || location.href.replace(/[^/]*(\?.*)?(#.*)?$/, '');
    return base.replace(/\/?$/, '/') + 'away.html';
  }
  function drawAwayLink() {
    const url = awayUrl();
    $('away-url').textContent = url;
    $('away-link').href = url;
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      $('away-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) { $('away-qr').innerHTML = ''; }
  }
  $('away-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(awayUrl()); toast('주소를 복사했어요'); }
    catch (e) { toast('복사하지 못했어요. 주소를 길게 눌러 복사해 주세요'); }
  });

  /* 쉬는 날 */
  const dateText = (k) => { const d = Core.dateOf(k); return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + Core.DAY_NAMES[d.getDay()] + '요일'; };
  function drawOffDates() {
    const list = store.state.settings.offDates || [];
    const today = store.state.day;
    $('off-list').innerHTML = list.length ? list.map((o) => '<li class="' + (o.date < today ? 'is-past' : '') + '"><span><b>' + dateText(o.date) + '</b>' + (o.label ? ' ' + esc(o.label) : '') + '</span><button type="button" class="btn btn--small btn--ghost" data-off="' + o.date + '">지우기</button></li>').join('') : '<li class="empty">없어요</li>';
  }
  async function saveOff(list) {
    const r = await act({ type: 'settings', settings: { offDates: list } });
    if (!r.ok) toast(r.error);
    drawOffDates();
    return r.ok;
  }
  $('off-add').addEventListener('click', async () => {
    const date = $('off-date').value;
    if (!date) { toast('날짜를 골라 주세요'); return; }
    const list = (store.state.settings.offDates || []).filter((o) => o.date !== date).concat({ date, label: $('off-label').value.trim() });
    if (await saveOff(list)) { toast(dateText(date) + '을 쉬는 날로 정했어요'); $('off-date').value = ''; $('off-label').value = ''; }
  });
  $('off-list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-off]');
    if (!b) return;
    if (await saveOff((store.state.settings.offDates || []).filter((o) => o.date !== b.dataset.off))) toast('쉬는 날을 지웠어요');
  });

  function renderSettingsInfo() {
    const s = store.state.settings;
    $('pin-info').textContent = '숫자 ' + pinLength() + '자리';
    const closed = s.closedSeats || [];
    $('closed-info').textContent = closed.length ? closed.map((n) => n + '번').join(', ') + '을 막아 뒀어요. 좌석 탭에서 자리를 누르면 다시 열 수 있어요' : '없어요. 좌석 탭에서 빈자리를 누르면 막을 수 있어요';
  }
  $('f-save').addEventListener('click', async () => {
    const start = $('f-start').value, end = $('f-end').value;
    if (!start || !end) { toast('시각을 넣어 주세요'); return; }
    const hook = $('f-hook').value.trim(), pub = $('f-public').value.trim();
    if (hook && !/^https?:\/\//.test(hook)) { toast('알림 주소는 http로 시작해야 해요'); return; }
    if (pub && !/^https?:\/\//.test(pub)) { toast('내 자리 주소는 http로 시작해야 해요'); return; }
    const res = await act({ type: 'settings', settings: { nightStart: start, nightEnd: end, days: days.slice().sort(), demoMode: $('f-demo').checked,
      autoRelease: $('f-auto').checked, fixedOnly: $('f-fixed').checked, notice: $('f-notice').value.trim(), lateMin: Number($('f-late').value), webhookUrl: hook, publicUrl: pub } });
    toast(res.ok ? '저장했어요' : res.error);
    if (res.ok) fillSettings();
  });
  $('f-lock').addEventListener('change', async () => {
    const res = await act({ type: 'settings', settings: { autoLockMin: Number($('f-lock').value) } });
    toast(res.ok ? ($('f-lock').value === '0' ? '자동으로 잠그지 않아요' : $('f-lock').selectedOptions[0].textContent + ' 잠가요') : res.error);
  });

  /* PIN 바꾸기: 지금 PIN, 새 PIN, 한 번 더 */
  let px = { step: 'current', buf: '', current: '', next: '' };
  function drawPinx(wrong) {
    const titles = { current: '지금 PIN을 눌러 주세요', next: '새 PIN을 눌러 주세요', again: '한 번 더 눌러 주세요' };
    $('pinx-title').textContent = titles[px.step];
    const n = px.step === 'current' ? pinLength() : px.step === 'again' ? px.next.length : Math.max(4, px.buf.length);
    drawDots($('pinx-dots'), n, px.buf.length, wrong);
    $('pinx-next').hidden = px.step !== 'next';
    $('pinx-next').disabled = px.buf.length < 4;
    if (px.step === 'next' && !wrong && px.warned !== px.buf) $('pinx-hint').textContent = '숫자 4~8자리로 정해 주세요';
  }
  function openPinx() {
    px = { step: 'current', buf: '', current: '', next: '' };
    $('pinx-hint').textContent = '';
    drawPinx();
    $('pinx').classList.add('is-open');
  }
  function closePinx() { $('pinx').classList.remove('is-open'); px = { step: 'current', buf: '', current: '', next: '' }; render(); }
  function pinxWrong(text, step) {
    drawPinx(true);
    $('pinx-hint').textContent = text;
    setTimeout(() => { px.buf = ''; if (step) px.step = step; drawPinx(); $('pinx-hint').textContent = text; }, 700);
  }
  async function pinxPress(k) {
    if (k === 'del') { px.buf = px.buf.slice(0, -1); drawPinx(); return; }
    const max = px.step === 'current' ? pinLength() : px.step === 'again' ? px.next.length : 8;
    if (px.buf.length >= max) return;
    px.buf += k;
    drawPinx();
    if (px.step === 'current' && px.buf.length === max) {
      px.current = px.buf; px.buf = ''; px.step = 'next';
      $('pinx-hint').textContent = '';
      drawPinx();
    } else if (px.step === 'again' && px.buf.length === max) {
      if (px.buf !== px.next) { pinxWrong('처음 누른 PIN과 달라요. 새 PIN부터 다시 눌러 주세요', 'next'); return; }
      const r = await act({ type: 'change-pin', current: px.current, next: px.next });
      if (!r.ok) {
        if (/지금 PIN/.test(r.error || '')) { px.current = ''; pinxWrong(r.error, 'current'); return; }
        pinxWrong(r.error || 'PIN을 바꾸지 못했어요', 'next');
        return;
      }
      if (SERVER) setAuth(r.token); else setAuth(px.next);
      closePinx();
      toast('PIN을 바꿨어요');
      renderSettingsInfo();
    }
  }
  $('pinx-pad').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) pinxPress(b.dataset.k === 'del' ? 'del' : b.textContent); });
  $('pinx-next').addEventListener('click', () => {
    if (px.buf.length < 4) return;
    /* 쉬운 PIN은 한 번 알려 주고, 그래도 다음을 누르면 쓴다 */
    const easy = /^(\d)\1+$/.test(px.buf) || '0123456789'.indexOf(px.buf) !== -1 || '9876543210'.indexOf(px.buf) !== -1;
    if (easy && px.warned !== px.buf) {
      px.warned = px.buf;
      $('pinx-hint').textContent = '누구나 맞힐 수 있는 PIN이에요. 그래도 쓰려면 다음을 한 번 더 눌러 주세요';
      return;
    }
    px.next = px.buf; px.buf = ''; px.step = 'again';
    $('pinx-hint').textContent = '';
    drawPinx();
  });
  $('pinx-cancel').addEventListener('click', closePinx);
  $('f-pin').addEventListener('click', openPinx);
  document.addEventListener('keydown', (e) => {
    if (!$('pinx').classList.contains('is-open')) return;
    if (/^\d$/.test(e.key)) pinxPress(e.key);
    else if (e.key === 'Backspace') pinxPress('del');
    else if (e.key === 'Enter' && px.step === 'next') $('pinx-next').click();
    else if (e.key === 'Escape') closePinx();
  });

  /* 백업 */
  $('f-backup').addEventListener('click', () => downloadFrom('api/backup', '자습실백업_' + store.state.day + '.json'));
  $('f-restore').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch (err) { toast('백업 파일을 읽지 못했어요'); return; }
    if (!data || data.kind !== 'study-room-kiosk-backup') { toast('이 앱의 백업 파일이 아니에요'); return; }
    const when = data.at ? new Date(data.at) : null;
    if (!(await ask((when ? (when.getMonth() + 1) + '월 ' + when.getDate() + '일 ' + Core.hhmm(when) + ' ' : '') + '백업으로 되돌릴까요?', '명단, 설정, 오늘 자리가 백업한 때로 바뀌어요. PIN은 그대로예요', '되돌릴게요', true))) return;
    try {
      const r = await (await api('api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json();
      if (!r.ok) { toast(r.error || '되돌리지 못했어요'); return; }
      await store.refresh();
      toast('백업으로 되돌렸어요');
      fillSettings();
      render();
    } catch (err) { if (err.message !== 'auth') toast('서버에 연결하지 못했어요'); }
  });

  /* 오늘 자리 */
  const typeName = { assign: '배정', move: '이동', release: '반납', out: '외출', back: '돌아옴' };
  $('f-log-export').addEventListener('click', () => {
    const st = store.state;
    if (SERVER) { downloadFrom('api/history.csv?day=' + st.day, '야자기록_' + st.day + '.csv'); return; }
    download('좌석기록_' + st.day + '.csv', '시각,구분,학번,이름,좌석,메모,처리\n' + st.log.slice().reverse().map((l) => csvLine([hm(l.at), typeName[l.type], l.id, l.name, l.seat, l.note === 'early' ? '조퇴' : '', l.by === 'teacher' ? '감독' : '키오스크'])).join('\n'));
  });
  $('f-demo-fill').addEventListener('click', async () => {
    const res = await act({ type: 'demo-fill' });
    toast(res.ok ? res.count + '명을 시연용으로 앉혔어요' : res.error);
  });
  $('f-reset').addEventListener('click', async () => {
    if (!(await ask('모든 자리를 비울까요?', '오늘 배정과 기록이 모두 지워져요', '비울게요', true))) return;
    const res = await act({ type: 'reset' });
    selected = null; selectedSeat = null; assigning = null;
    toast(res.ok ? '모든 자리를 비웠어요' : res.error);
  });

  if (await stillIn()) openMain();
  else setAuth('');
})();
