/* 감독 화면 */
(async function () {
  'use strict';
  const Core = window.KioskCore;
  const $ = (id) => document.getElementById(id);
  const store = await window.KioskStore.open();
  const layout = store.layout;
  const PIN_KEY = 'study-room-kiosk/pin';
  const RECENT_MS = 5 * 60 * 1000;
  let pin = '';
  try { pin = sessionStorage.getItem(PIN_KEY) || ''; } catch (e) {}
  let tab = 'map';
  let selected = null;     // 상세 정보에 보이는 학생 학번
  let assigning = null;    // 자리 지정 중인 학생
  let logFilter = 'all';

  $('mode').textContent = store.mode === 'server' ? '서버' : '이 기기 저장';
  $('gate-hint').textContent = store.mode === 'server' ? '' : '처음 PIN은 0000, 설정에서 변경';

  /* 공통 도구 */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTime = (iso) => Core.hhmm(new Date(iso));
  const typeName = { assign: '배정', move: '이동', release: '반납' };
  function grade(id) { return Number(String(id)[0]) || 0; }
  function classKey(id) { id = String(id); return id[0] + '-' + Number(id.slice(1, 3)); }
  function classLabel(id) { id = String(id); return id[0] + '학년 ' + Number(id.slice(1, 3)) + '반 ' + Number(id.slice(3, 5)) + '번'; }
  function since(iso) {
    const m = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000));
    if (m < 1) return '방금';
    if (m < 60) return m + '분 전';
    return Math.floor(m / 60) + '시간 ' + (m % 60) + '분 전';
  }
  function duration(iso) {
    const m = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000));
    return m < 60 ? m + '분' : Math.floor(m / 60) + '시간 ' + (m % 60) + '분';
  }
  function toMin(hm) { const [h, m] = hm.split(':').map(Number); return h * 60 + m; }

  function toast(text, isError) {
    const t = $('toast');
    t.textContent = text;
    t.className = 'toast is-show' + (isError ? ' toast--error' : '');
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.className = 'toast'; }, 2600);
  }

  /* 확인 창 (브라우저 confirm 대신) */
  function ask(title, body, yesText, danger) {
    return new Promise((resolve) => {
      $('confirm-title').textContent = title;
      $('confirm-body').textContent = body || '';
      const yes = $('confirm-yes');
      yes.textContent = yesText || '확인';
      yes.className = 'btn ' + (danger ? 'btn--danger' : 'btn--primary');
      $('confirm').classList.add('is-open');
      const done = (v) => { $('confirm').classList.remove('is-open'); yes.onclick = null; $('confirm-no').onclick = null; resolve(v); };
      yes.onclick = () => done(true);
      $('confirm-no').onclick = () => done(false);
    });
  }

  /* PIN */
  async function checkPin(p) {
    if (store.mode === 'local') return p === store.state.settings.pin;
    try {
      const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: p }) });
      return (await r.json()).ok === true;
    } catch (e) { return false; }
  }
  async function enter() {
    const p = $('pin').value.trim();
    if (!(await checkPin(p))) { toast('PIN 불일치', true); $('pin').value = ''; return; }
    pin = p;
    try { sessionStorage.setItem(PIN_KEY, pin); } catch (e) {}
    openMain();
  }
  $('pin-ok').addEventListener('click', enter);
  $('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });

  function openMain() {
    $('gate').hidden = true;
    $('main').hidden = false;
    fillSettings();
    render();
  }

  const admin = (action) => store.dispatch(Object.assign({ pin, byTeacher: action.type === 'assign' || action.type === 'release' }, action));

  /* 탭 */
  function setTab(t) {
    tab = t;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('is-on', x.dataset.tab === t));
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('is-on', x.id === 't-' + t));
    if (t === 'settings') fillSettings();
    render();
  }
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });

  /* 계산 */
  function summary() {
    const st = store.state;
    const seatedIds = new Set(Object.values(st.seats).map((s) => s.id));
    const night = st.roster.filter((s) => s.night !== false);
    const absent = night.filter((s) => !seatedIds.has(s.id));
    const extra = st.roster.filter((s) => s.night === false && seatedIds.has(s.id));
    const total = Core.allSeatNumbers(layout).length;
    return { st, seatedIds, night, absent, extra, total, used: Object.keys(st.seats).length };
  }

  function render() {
    if ($('main').hidden) return;
    const s = summary();
    const now = new Date();
    $('clock').textContent = Core.hhmm(now);
    $('today').textContent = (now.getMonth() + 1) + '월 ' + now.getDate() + '일 ' + '일월화수목금토'[now.getDay()] + '요일';

    renderOverview(s, now);
    $('tab-absent-n').textContent = s.absent.length;
    if (tab === 'map') renderBoard(s);
    if (tab === 'absent') renderAbsent(s);
    if (tab === 'stats') renderStats(s, now);
    $('roster-count').textContent = s.st.roster.length;
  }

  function renderOverview(s, now) {
    const set = s.st.settings;
    const nowM = now.getHours() * 60 + now.getMinutes();
    const a = toMin(set.nightStart), b = toMin(set.nightEnd);
    let text;
    if (Core.isNightTime(s.st, now)) {
      const left = b - nowM;
      text = '야자 운영 중 (' + set.nightStart + '~' + set.nightEnd + '), 종료까지 ' + (left >= 60 ? Math.floor(left / 60) + '시간 ' : '') + (left % 60) + '분';
    } else if (nowM < a) {
      const left = a - nowM;
      text = '야자 시작 전, ' + set.nightStart + ' 시작까지 ' + (left >= 60 ? Math.floor(left / 60) + '시간 ' : '') + (left % 60) + '분';
    } else {
      text = '오늘 야자 종료 (' + set.nightEnd + ')';
    }
    if (set.demoMode) text += ', 시연 모드 켜짐';
    $('run-state').textContent = text;
    const rate = s.night.length ? Math.round((s.night.length - s.absent.length) / s.night.length * 100) : 0;
    $('st-night').textContent = s.night.length;
    $('st-in').textContent = s.night.length - s.absent.length;
    $('st-rate').textContent = rate + '%';
    $('st-absent').textContent = s.absent.length;
    $('st-extra').textContent = s.extra.length;
    $('st-free').textContent = s.total - s.used;
    $('st-total').textContent = '/' + s.total;
    $('meter').style.width = rate + '%';
  }

  /* 좌석 현황 */
  function renderBoard(s) {
    const st = s.st;
    const selSeat = selected ? Core.seatOf(st, selected) : null;
    const map = window.SeatMap.render($('map'), layout, st, {
      mode: 'admin',
      decorate(el, no, occ) {
        if (no === selSeat) el.classList.add('is-selected');
        if (assigning && !occ) el.classList.add('is-target');
        if (!occ) return;
        el.classList.add('g' + grade(occ.id));
        if (Date.now() - new Date(occ.at) < RECENT_MS) el.classList.add('is-new');
        const t = document.createElement('span');
        t.className = 'seat__time';
        t.textContent = fmtTime(occ.at);
        el.appendChild(t);
      },
      onSeat(no, occ) {
        if (assigning) {
          if (occ) { toast(no + '번은 사용 중', true); return; }
          doAssign(assigning, no);
          return;
        }
        if (occ) { selected = occ.id; render(); }
        else { selected = null; render(); }
      }
    });
    requestAnimationFrame(() => window.SeatMap.fit($('map'), map, 1.25));
    renderDetail(s);
    renderFeed(st);
    $('assign-hint').hidden = !assigning;
    if (assigning) {
      const stu = Core.findStudent(st, assigning);
      $('assign-hint-text').textContent = (stu ? stu.name + ' ' + stu.id : assigning) + ', 지정할 빈자리 선택';
    }
  }

  function renderDetail(s) {
    const box = $('detail');
    const st = s.st;
    const stu = selected ? Core.findStudent(st, selected) : null;
    if (!stu) {
      box.innerHTML = '<p class="detail__empty">배치도에서 좌석을 누르거나 학생을 검색하면 여기에 자세한 정보가 나옴</p>';
      return;
    }
    const seat = Core.seatOf(st, stu.id);
    const occ = seat !== null ? st.seats[seat] : null;
    const history = st.log.filter((l) => l.id === stu.id);
    box.innerHTML =
      '<div class="detail__top"><div><div class="detail__name">' + esc(stu.name) + '</div>'
      + '<div class="detail__id">' + stu.id + ', ' + classLabel(stu.id) + '</div></div>'
      + '<div class="detail__seat">' + (seat !== null ? seat + '<small>번</small>' : '<span class="detail__none">미입실</span>') + '</div></div>'
      + '<dl class="detail__dl">'
      + '<dt>야자 신청</dt><dd>' + (stu.night === false ? '안 함' : '함') + '</dd>'
      + (occ ? '<dt>배정 시각</dt><dd>' + fmtTime(occ.at) + '</dd><dt>이용 시간</dt><dd>' + duration(occ.at) + '</dd>' : '')
      + '<dt>오늘 기록</dt><dd>' + (history.length ? history.length + '건' : '없음') + '</dd>'
      + '</dl>'
      + (history.length ? '<ol class="detail__hist">' + history.slice(0, 5).map((l) => '<li><time>' + fmtTime(l.at) + '</time>' + logText(l) + '</li>').join('') + '</ol>' : '')
      + '<div class="detail__actions"></div>';
    const acts = box.querySelector('.detail__actions');
    const btn = (text, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn--small ' + cls; b.textContent = text; b.onclick = fn; acts.appendChild(b); };
    if (seat !== null) {
      btn('자리 이동', '', () => startAssign(stu.id));
      btn('반납 처리', 'btn--danger', async () => {
        if (!(await ask(seat + '번 반납 처리', stu.name + ' ' + stu.id, '반납', true))) return;
        const r = await admin({ type: 'release', id: stu.id });
        toast(r.ok ? seat + '번 반납 처리 완료' : r.error, !r.ok);
      });
    } else {
      btn('자리 지정', 'btn--primary', () => startAssign(stu.id));
    }
    btn('닫기', '', () => { selected = null; render(); });
  }

  function logText(l) {
    const by = l.by === 'teacher' ? ' (감독)' : '';
    if (l.type === 'move') return (l.from ? l.from + '번에서 ' : '') + l.seat + '번으로 이동' + by;
    if (l.type === 'release') return l.seat + '번 반납' + by;
    return l.seat + '번 배정' + by;
  }

  function renderFeed(st) {
    const items = st.log.slice(0, 8);
    $('feed').innerHTML = items.length
      ? items.map((l) => '<li class="feed__item feed__item--' + l.type + '"><button type="button" data-id="' + l.id + '"><b>' + esc(l.name) + '</b> ' + logText(l) + '</button><time>' + since(l.at) + '</time></li>').join('')
      : '<li class="feed__empty">아직 기록 없음</li>';
  }
  $('feed').addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (b) { selected = b.dataset.id; render(); } });

  /* 자리 지정과 이동 */
  function startAssign(id) {
    assigning = id;
    selected = id;
    if (tab !== 'map') setTab('map'); else render();
  }
  $('assign-cancel').addEventListener('click', () => { assigning = null; render(); });
  async function doAssign(id, seat) {
    const r = await admin({ type: 'assign', id, seat });
    if (!r.ok) { toast(r.error, true); return; }
    assigning = null;
    selected = id;
    toast(r.student.name + ' ' + seat + '번 ' + (r.moved ? '이동' : '지정') + ' 완료');
    render();
  }

  /* 검색 */
  $('search').addEventListener('input', () => {
    const q = $('search').value.trim().toLowerCase();
    const ul = $('search-results');
    if (!q) { ul.innerHTML = ''; return; }
    const st = store.state;
    const hits = st.roster.filter((s) => s.id.includes(q) || s.name.toLowerCase().includes(q)).slice(0, 6);
    ul.innerHTML = hits.length
      ? hits.map((s) => { const seat = Core.seatOf(st, s.id); return '<li><button type="button" data-id="' + s.id + '"><span>' + esc(s.name) + ' <small>' + s.id + '</small></span><span class="' + (seat !== null ? 'pill' : 'pill pill--off') + '">' + (seat !== null ? seat + '번' : '미입실') + '</span></button></li>'; }).join('')
      : '<li class="search-results__none">찾는 학생 없음</li>';
  });
  $('search-results').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    selected = b.dataset.id;
    $('search').value = '';
    $('search-results').innerHTML = '';
    render();
  });

  /* 미입실 */
  function renderAbsent(s) {
    const groups = new Map();
    s.absent.forEach((stu) => { const k = classKey(stu.id); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(stu); });
    const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    $('absent-classes').innerHTML = keys.length
      ? keys.map((k) => { const [g, c] = k.split('-'); return '<div class="class-card"><div class="class-card__h">' + g + '학년 ' + c + '반 <span>' + groups.get(k).length + '명</span></div><div class="chips">' + groups.get(k).map((stu) => '<button type="button" class="chip-btn" data-id="' + stu.id + '">' + esc(stu.name) + ' <small>' + stu.id.slice(3) + '</small></button>').join('') + '</div></div>'; }).join('')
      : '<p class="note">야자 신청자 모두 입실</p>';
    $('extra-list').innerHTML = s.extra.length
      ? s.extra.map((stu) => '<button type="button" class="chip-btn" data-id="' + stu.id + '" data-view="1">' + esc(stu.name) + ' <small>' + Core.seatOf(s.st, stu.id) + '번</small></button>').join('')
      : '<p class="note">없음</p>';
  }
  $('t-absent').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    if (b.dataset.view) { selected = b.dataset.id; setTab('map'); return; }
    startAssign(b.dataset.id);
  });

  /* 기록과 통계 */
  function renderStats(s, now) {
    const st = s.st;
    const set = st.settings;
    const start = toMin(set.nightStart);
    const nowM = now.getHours() * 60 + now.getMinutes();
    const assigns = st.log.filter((l) => l.type === 'assign');
    /* 배정이 있으면 첫 배정부터 지금까지, 없으면 야자 시작부터 한 시간 */
    let from = start, to = start + 60;
    if (assigns.length) {
      const ms = assigns.map((l) => { const d = new Date(l.at); return d.getHours() * 60 + d.getMinutes(); });
      from = Math.floor(Math.min(...ms) / 10) * 10;
      to = Math.max(Math.max(...ms) + 10, Math.min(nowM + 10, toMin(set.nightEnd)));
      to = Math.min(to, from + 6 * 60);
    }
    const buckets = [];
    for (let m = Math.floor(from / 10) * 10; m < to; m += 10) buckets.push({ m, n: 0 });
    assigns.forEach((l) => { const d = new Date(l.at); const m = d.getHours() * 60 + d.getMinutes(); const b = buckets.find((x) => m >= x.m && m < x.m + 10); if (b) b.n += 1; });
    const max = Math.max(1, ...buckets.map((b) => b.n));
    const lab = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    $('timeline').innerHTML = buckets.map((b) => '<div class="bars__col" title="' + lab(b.m) + ' ' + b.n + '명"><span class="bars__n">' + (b.n || '') + '</span><div class="bars__bar" style="height:' + (b.n / max * 100) + '%"></div><span class="bars__t">' + (b.m % 30 === 0 ? lab(b.m) : '') + '</span></div>').join('');

    const cls = new Map();
    s.night.forEach((stu) => { const k = classKey(stu.id); if (!cls.has(k)) cls.set(k, { n: 0, in: 0 }); const c = cls.get(k); c.n += 1; if (s.seatedIds.has(stu.id)) c.in += 1; });
    const ck = [...cls.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    $('class-rates').innerHTML = ck.map((k) => { const c = cls.get(k); const r = Math.round(c.in / c.n * 100); const [g, n] = k.split('-'); return '<tr><td>' + g + '-' + n + '</td><td>' + c.n + '</td><td>' + c.in + '</td><td class="w-bar"><div class="rate"><div class="rate__fill" style="width:' + r + '%"></div></div><span class="rate__n">' + r + '%</span></td></tr>'; }).join('');

    const rows = st.log.filter((l) => logFilter === 'all' || l.type === logFilter);
    $('log').innerHTML = rows.length
      ? rows.map((l) => '<tr><td>' + fmtTime(l.at) + '</td><td><span class="tag tag--' + l.type + '">' + typeName[l.type] + '</span></td><td>' + l.id + '</td><td>' + esc(l.name) + '</td><td>' + (l.type === 'move' && l.from ? l.from + ' → ' : '') + l.seat + '</td><td>' + (l.by === 'teacher' ? '감독' : '키오스크') + '</td></tr>').join('')
      : '<tr><td colspan="6">기록 없음</td></tr>';
  }
  $('log-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    logFilter = b.dataset.f;
    document.querySelectorAll('#log-filter button').forEach((x) => x.classList.toggle('is-on', x === b));
    render();
  });

  store.subscribe(render);
  setInterval(render, 20000);

  /* 설정 */
  function fillSettings() {
    const s = store.state.settings;
    $('f-start').value = s.nightStart;
    $('f-end').value = s.nightEnd;
    $('f-demo').checked = !!s.demoMode;
    $('f-hook').value = s.webhookUrl || '';
    $('f-public').value = s.publicUrl || '';
    $('f-pin').value = '';
  }
  $('f-save').addEventListener('click', async () => {
    const settings = {
      nightStart: $('f-start').value || '18:00',
      nightEnd: $('f-end').value || '22:30',
      demoMode: $('f-demo').checked,
      webhookUrl: $('f-hook').value.trim(),
      publicUrl: $('f-public').value.trim()
    };
    const np = $('f-pin').value.trim();
    if (np) {
      if (!/^\d{4,8}$/.test(np)) { toast('PIN은 숫자 4~8자리', true); return; }
      settings.pin = np;
    }
    const res = await store.dispatch({ type: 'settings', settings, pin });
    if (!res.ok) { toast(res.error, true); return; }
    if (np) { pin = np; try { sessionStorage.setItem(PIN_KEY, pin); } catch (e) {} }
    toast('설정 저장 완료');
    fillSettings();
  });

  $('f-csv').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const roster = Core.parseRosterCsv(await f.text());
    if (!roster.length) { toast('읽을 수 있는 학생 없음, 형식 확인', true); return; }
    if (!(await ask('명단 교체', roster.length + '명으로 교체. 명단에 없는 학생의 좌석은 비워짐.', '교체'))) return;
    const res = await store.dispatch({ type: 'roster', roster, pin });
    toast(res.ok ? '명단 교체 완료' : res.error, !res.ok);
  });

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('f-export').addEventListener('click', () => {
    download('명단.csv', '학번,이름,야자신청\n' + store.state.roster.map((s) => s.id + ',' + s.name + ',' + (s.night === false ? 0 : 1)).join('\n'));
  });
  $('f-log-export').addEventListener('click', () => {
    const st = store.state;
    download('좌석기록_' + st.day + '.csv', '시각,구분,학번,이름,좌석,처리\n' + st.log.slice().reverse().map((l) => fmtTime(l.at) + ',' + typeName[l.type] + ',' + l.id + ',' + l.name + ',' + l.seat + ',' + (l.by === 'teacher' ? '감독' : '키오스크')).join('\n'));
  });
  $('f-demo-fill').addEventListener('click', async () => {
    const res = await store.dispatch({ type: 'demo-fill', pin });
    toast(res.ok ? res.count + '명 시연용 배정' : res.error, !res.ok);
  });
  $('f-reset').addEventListener('click', async () => {
    if (!(await ask('모든 좌석 비우기', '오늘 배정과 기록이 모두 지워짐', '비우기', true))) return;
    const res = await store.dispatch({ type: 'reset', pin });
    selected = null; assigning = null;
    toast(res.ok ? '모든 좌석 비움' : res.error, !res.ok);
  });

  if (pin && (await checkPin(pin))) openMain();
  else { try { sessionStorage.removeItem(PIN_KEY); } catch (e) {} }
})();
