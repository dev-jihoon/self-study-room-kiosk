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
  let selected = null;     // 오른쪽에 보이는 학생
  let assigning = null;    // 자리를 정해 주는 중인 학생
  let logFilter = 'all';

  const gateHint = store.mode === 'server' ? '' : '처음 PIN은 0000이에요';
  $('gate-hint').textContent = gateHint;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hm = (iso) => Core.hhmm(new Date(iso));
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const klass = (id) => String(id)[0] + '학년 ' + Number(String(id).slice(1, 3)) + '반';
  const fullClass = (id) => klass(id) + ' ' + Number(String(id).slice(3, 5)) + '번';
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
    t._h = setTimeout(() => { t.className = 'toast'; }, 2400);
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

  /* PIN */
  async function checkPin(p) {
    if (store.mode === 'local') return p === store.state.settings.pin;
    try {
      const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: p }) });
      return (await r.json()).ok === true;
    } catch (e) { return false; }
  }
  /* PIN 키패드: 4자리부터 누를 때마다 맞는지 확인하고, 8자리까지 틀리면 지운다 */
  let pinBuf = '';
  const pinLength = () => { const st = store.state.settings; return st.pin ? st.pin.length : (st.pinLength || 8); };
  let checking = false;
  function drawDots(wrong) {
    const n = Math.max(pinLength() <= 8 ? pinLength() : 4, pinBuf.length);
    $('dots').innerHTML = Array.from({ length: n }, (_, i) => '<i class="' + (i < pinBuf.length ? 'is-on' : '') + '"></i>').join('');
    $('dots').classList.toggle('is-wrong', !!wrong);
  }
  async function pressPin(k) {
    if (checking) return;
    if (k === 'del') { pinBuf = pinBuf.slice(0, -1); drawDots(); return; }
    if (pinBuf.length >= 8) return;
    pinBuf += k;
    drawDots();
    if (pinBuf.length < 4) return;
    checking = true;
    const ok = await checkPin(pinBuf);
    checking = false;
    if (ok) {
      pin = pinBuf;
      try { sessionStorage.setItem(PIN_KEY, pin); } catch (e) {}
      pinBuf = '';
      openMain();
    } else if (pinBuf.length >= pinLength()) {
      drawDots(true);
      $('gate-hint').textContent = 'PIN이 맞지 않아요';
      setTimeout(() => { pinBuf = ''; drawDots(); $('gate-hint').textContent = gateHint; }, 900);
    }
  }
  $('pinpad').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    pressPin(b.dataset.k === 'del' ? 'del' : b.textContent);
  });
  document.addEventListener('keydown', (e) => {
    if ($('gate').hidden) return;
    if (/^\d$/.test(e.key)) pressPin(e.key);
    else if (e.key === 'Backspace') pressPin('del');
  });
  drawDots();

  function openMain() {
    $('gate').hidden = true;
    $('main').hidden = false;
    fillSettings();
    render();
  }

  const teacher = (action) => store.dispatch(Object.assign({ pin, byTeacher: true }, action));
  const adminAct = (action) => store.dispatch(Object.assign({ pin }, action));

  /* 탭 */
  function setTab(t) {
    tab = t;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('is-on', x.dataset.tab === t));
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('is-on', x.id === 't-' + t));
    if (t === 'settings') fillSettings();
    render();
  }
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
  $('go-absent').addEventListener('click', () => setTab('absent'));

  function counts() {
    const st = store.state;
    const seated = new Set(Object.values(st.seats).map((s) => s.id));
    const night = st.roster.filter((s) => s.night !== false);
    const absent = night.filter((s) => !seated.has(s.id));
    const extra = st.roster.filter((s) => s.night === false && seated.has(s.id));
    return { st, seated, night, absent, extra };
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
    if (tab === 'stats') renderStats(c, now);
    $('roster-count').textContent = c.st.roster.length + '명';
  }

  function renderSummary(c, now) {
    const set = c.st.settings;
    const nowM = now.getHours() * 60 + now.getMinutes();
    const start = toMin(set.nightStart);
    let state;
    if (Core.isNightTime(c.st, now)) state = '야자 중이에요. ' + set.nightEnd + '에 끝나요';
    else if (nowM < start) state = set.nightStart + '에 야자가 시작돼요';
    else state = '오늘 야자는 끝났어요';
    if (set.demoMode) state += ' (시연 모드)';
    $('run-state').textContent = state;
    const came = c.night.length - c.absent.length;
    $('sum-title').innerHTML = '신청한 ' + c.night.length + '명 중 <b>' + came + '명</b>이 왔어요';
    $('meter').style.width = (c.night.length ? came / c.night.length * 100 : 0) + '%';
    const go = $('go-absent');
    go.textContent = c.absent.length ? '아직 안 온 학생 ' + c.absent.length + '명' : '신청한 학생이 모두 왔어요';
    go.classList.toggle('is-warn', c.absent.length > 0);
    $('sum-extra').textContent = c.extra.length ? '신청 안 하고 온 학생 ' + c.extra.length + '명' : '';
  }

  /* 좌석 */
  function renderBoard(c) {
    const st = c.st;
    const selSeat = selected ? Core.seatOf(st, selected) : null;
    const map = window.SeatMap.render($('map'), layout, st, {
      mode: 'admin',
      decorate(el, no, occ) {
        if (no === selSeat) el.classList.add('is-selected');
        if (assigning && !occ) el.classList.add('is-target');
        if (occ && Date.now() - new Date(occ.at) < RECENT_MS) el.classList.add('is-new');
      },
      onSeat(no, occ) {
        if (assigning) {
          if (occ) { toast('이미 누가 앉아 있어요'); return; }
          doAssign(assigning, no);
          return;
        }
        selected = occ ? occ.id : null;
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

  function renderDetail(st) {
    const box = $('detail');
    const stu = selected ? Core.findStudent(st, selected) : null;
    $('feed-box').hidden = !!stu;
    if (!stu) { box.innerHTML = ''; box.className = ''; return; }
    box.className = 'detail';
    const seat = Core.seatOf(st, stu.id);
    const occ = seat !== null ? st.seats[seat] : null;
    const hist = st.log.filter((l) => l.id === stu.id);
    const rows = [['자리', seat !== null ? seat + '번' : '아직 안 왔어요']];
    if (occ) {
      rows.push(['들어온 시각', hm(occ.at)]);
      rows.push(['있었던 시간', length(Math.floor((Date.now() - new Date(occ.at)) / 60000))]);
    }
    rows.push(['야자 신청', stu.night === false ? '안 했어요' : '했어요']);
    box.innerHTML =
      '<div class="detail__top"><div><div class="detail__name">' + esc(stu.name) + '</div><div class="detail__sub">' + fullClass(stu.id) + ', 학번 ' + stu.id + '</div></div>'
      + '<button type="button" class="detail__close" id="detail-close">닫기</button></div>'
      + '<dl class="detail__rows">' + rows.map((r) => '<div><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>').join('') + '</dl>'
      + (hist.length ? '<ol class="detail__hist">' + hist.slice(0, 4).map((l) => '<li><time>' + hm(l.at) + '</time>' + logText(l) + '</li>').join('') + '</ol>' : '')
      + '<div class="btn-row" id="detail-actions"></div>';
    $('detail-close').onclick = () => { selected = null; render(); };
    const acts = $('detail-actions');
    const add = (text, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ' + cls; b.textContent = text; b.onclick = fn; acts.appendChild(b); };
    if (seat !== null) {
      add('자리 옮기기', '', () => startAssign(stu.id));
      add('반납 처리', 'btn--danger', async () => {
        if (!(await ask(stu.name + '님 자리를 반납할까요?', seat + '번이 빈자리가 돼요', '반납할게요', true))) return;
        const r = await teacher({ type: 'release', id: stu.id });
        toast(r.ok ? seat + '번을 반납했어요' : r.error);
      });
    } else {
      add('자리 정해 주기', 'btn--primary', () => startAssign(stu.id));
    }
  }

  function logText(l) {
    const who = l.by === 'teacher' ? ' (감독)' : '';
    if (l.type === 'move') return (l.from ? l.from + '번에서 ' : '') + l.seat + '번으로 옮겼어요' + who;
    if (l.type === 'release') return l.seat + '번을 반납했어요' + who;
    return l.seat + '번에 앉았어요' + who;
  }

  function renderFeed(st) {
    const items = st.log.slice(0, 7);
    $('feed').innerHTML = items.length
      ? items.map((l) => '<li><button type="button" data-id="' + l.id + '"><b>' + esc(l.name) + '</b>' + logText(l) + '</button><time>' + ago(l.at) + '</time></li>').join('')
      : '<li class="feed__empty">아직 아무도 안 왔어요</li>';
  }
  $('feed').addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (b) { selected = b.dataset.id; render(); } });

  function startAssign(id) {
    assigning = id;
    selected = id;
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
  $('search').addEventListener('input', () => {
    const q = $('search').value.trim().toLowerCase();
    const ul = $('results');
    if (!q) { ul.innerHTML = ''; return; }
    const st = store.state;
    const hits = st.roster.filter((s) => s.id.includes(q) || s.name.toLowerCase().includes(q)).slice(0, 6);
    ul.innerHTML = hits.length
      ? hits.map((s) => { const seat = Core.seatOf(st, s.id); return '<li><button type="button" data-id="' + s.id + '"><span>' + esc(s.name) + '<small>' + s.id + '</small></span><span class="tag' + (seat === null ? ' tag--off' : '') + '">' + (seat !== null ? seat + '번' : '안 왔어요') + '</span></button></li>'; }).join('')
      : '<li class="results__none">찾는 학생이 없어요</li>';
  });
  $('results').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    selected = b.dataset.id;
    $('search').value = '';
    $('results').innerHTML = '';
    render();
  });

  /* 안 온 학생 */
  function renderAbsent(c) {
    $('absent-title').textContent = c.absent.length ? '아직 안 온 학생 ' + c.absent.length + '명' : '신청한 학생이 모두 왔어요';
    const groups = new Map();
    c.absent.forEach((s) => { const k = klass(s.id); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
    $('absent-classes').innerHTML = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((k) =>
      '<div class="class-card"><div class="class-card__h">' + k + '<span>' + groups.get(k).length + '명</span></div><div class="chips">'
      + groups.get(k).map((s) => '<button type="button" class="chip-btn" data-id="' + s.id + '">' + esc(s.name) + '<small>' + Number(s.id.slice(3)) + '번</small></button>').join('')
      + '</div></div>').join('');
    $('extra-list').innerHTML = c.extra.length
      ? c.extra.map((s) => '<button type="button" class="chip-btn" data-id="' + s.id + '" data-view="1">' + esc(s.name) + '<small>' + Core.seatOf(c.st, s.id) + '번</small></button>').join('')
      : '<p class="empty">없어요</p>';
  }
  $('t-absent').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    if (b.dataset.view) { selected = b.dataset.id; setTab('map'); return; }
    startAssign(b.dataset.id);
  });

  /* 기록 */
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
    $('class-rates').innerHTML = [...cls.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((k) => {
      const x = cls.get(k);
      return '<li><span>' + k.replace('학년 ', '-').replace('반', '') + '반</span><div class="rates__bar"><span style="width:' + (x.came / x.n * 100) + '%"></span></div><span class="rates__n">' + x.came + ' / ' + x.n + '명</span></li>';
    }).join('');

    const rows = st.log.filter((l) => logFilter === 'all' || l.type === logFilter);
    $('log').innerHTML = rows.length
      ? rows.map((l) => '<li><time>' + hm(l.at) + '</time><span><b>' + esc(l.name) + '</b><small>' + l.id + '</small> ' + logText(l).replace(' (감독)', '') + '</span><span class="by">' + (l.by === 'teacher' ? '감독' : '키오스크') + '</span></li>').join('')
      : '<li><span></span><span class="empty">기록이 없어요</span></li>';
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
      if (!/^\d{4,8}$/.test(np)) { toast('PIN은 숫자 4~8자리로 정해 주세요'); return; }
      settings.pin = np;
    }
    const res = await adminAct({ type: 'settings', settings });
    if (!res.ok) { toast(res.error); return; }
    if (np) { pin = np; try { sessionStorage.setItem(PIN_KEY, pin); } catch (e) {} }
    toast('저장했어요');
    fillSettings();
  });

  $('f-csv').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const roster = Core.parseRosterCsv(await f.text());
    if (!roster.length) { toast('읽을 수 있는 학생이 없어요. 파일 형식을 확인해 주세요'); return; }
    if (!(await ask(roster.length + '명으로 명단을 바꿀까요?', '새 명단에 없는 학생의 자리는 비워져요', '바꿀게요'))) return;
    const res = await adminAct({ type: 'roster', roster });
    toast(res.ok ? '명단을 바꿨어요' : res.error);
  });

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const typeName = { assign: '배정', move: '이동', release: '반납' };
  $('f-export').addEventListener('click', () => {
    download('명단.csv', '학번,이름,야자신청\n' + store.state.roster.map((s) => s.id + ',' + s.name + ',' + (s.night === false ? 0 : 1)).join('\n'));
  });
  $('f-log-export').addEventListener('click', () => {
    const st = store.state;
    download('좌석기록_' + st.day + '.csv', '시각,구분,학번,이름,좌석,처리\n' + st.log.slice().reverse().map((l) => hm(l.at) + ',' + typeName[l.type] + ',' + l.id + ',' + l.name + ',' + l.seat + ',' + (l.by === 'teacher' ? '감독' : '키오스크')).join('\n'));
  });
  $('f-demo-fill').addEventListener('click', async () => {
    const res = await adminAct({ type: 'demo-fill' });
    toast(res.ok ? res.count + '명을 시연용으로 앉혔어요' : res.error);
  });
  $('f-reset').addEventListener('click', async () => {
    if (!(await ask('모든 자리를 비울까요?', '오늘 배정과 기록이 모두 지워져요', '비울게요', true))) return;
    const res = await adminAct({ type: 'reset' });
    selected = null; assigning = null;
    toast(res.ok ? '모든 자리를 비웠어요' : res.error);
  });

  if (pin && (await checkPin(pin))) openMain();
  else { try { sessionStorage.removeItem(PIN_KEY); } catch (e) {} }
})();
