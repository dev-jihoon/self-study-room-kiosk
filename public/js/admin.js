/* 감독 화면 */
(async function () {
  'use strict';
  const Core = window.KioskCore;
  const $ = (id) => document.getElementById(id);
  const store = await window.KioskStore.open();
  const layout = store.layout;
  const PIN_KEY = 'study-room-kiosk/pin';
  let pin = sessionStorage.getItem(PIN_KEY) || '';
  let tab = 'map';
  let target = null;

  $('mode').textContent = store.mode === 'server' ? '서버 모드' : '이 기기 저장 모드';
  $('gate-hint').textContent = store.mode === 'server' ? '' : '처음 PIN은 0000입니다. 설정에서 바꿀 수 있습니다.';

  function toast(text, isError) {
    const t = $('toast');
    t.textContent = text;
    t.className = 'toast is-show' + (isError ? ' toast--error' : '');
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.className = 'toast'; }, 2600);
  }

  async function checkPin(p) {
    if (store.mode === 'local') return p === store.state.settings.pin;
    try {
      const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: p }) });
      return (await r.json()).ok === true;
    } catch (e) { return false; }
  }

  async function enter() {
    const p = $('pin').value.trim();
    if (!(await checkPin(p))) { toast('PIN이 맞지 않습니다.', true); $('pin').value = ''; return; }
    pin = p;
    sessionStorage.setItem(PIN_KEY, pin);
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

  const admin = (action) => store.dispatch(Object.assign({ pin }, action));

  /* 탭 */
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('is-on', x === b));
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('is-on', x.id === 't-' + tab));
    if (tab === 'settings') fillSettings();
  });

  const typeName = { assign: '배정', move: '이동', release: '반납', 'force-release': '감독 반납' };
  const fmtTime = (iso) => { const d = new Date(iso); return Core.hhmm(d); };

  function render() {
    if ($('main').hidden) return;
    const st = store.state;
    $('clock').textContent = Core.hhmm();
    const seated = new Set(Object.values(st.seats).map((s) => s.id));
    const night = st.roster.filter((s) => s.night !== false);
    const absent = night.filter((s) => !seated.has(s.id));
    const total = Core.allSeatNumbers(layout).length;
    $('st-night').textContent = night.length;
    $('st-in').textContent = seated.size;
    $('st-absent').textContent = absent.length;
    $('st-free').textContent = total - Object.keys(st.seats).length;
    $('roster-count').textContent = st.roster.length;

    window.SeatMap.render($('map'), layout, st, {
      mode: 'admin',
      onSeat(no, occ) {
        if (!occ) return;
        target = occ;
        $('modal-title').textContent = no + '번 ' + occ.name;
        $('modal-body').textContent = occ.id + ', ' + fmtTime(occ.at) + '에 배정';
        $('modal').classList.add('is-open');
      }
    });

    $('absent').innerHTML = absent.length
      ? absent.map((s) => '<tr><td>' + s.id + '</td><td>' + esc(s.name) + '</td></tr>').join('')
      : '<tr><td colspan="2">모두 입실했습니다.</td></tr>';

    $('log').innerHTML = st.log.length
      ? st.log.map((l) => '<tr><td>' + fmtTime(l.at) + '</td><td>' + (typeName[l.type] || l.type) + '</td><td>' + l.id + '</td><td>' + esc(l.name) + '</td><td>' + l.seat + '</td></tr>').join('')
      : '<tr><td colspan="5">오늘 기록이 없습니다.</td></tr>';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  store.subscribe(render);
  setInterval(render, 10000);

  /* 감독 반납 */
  $('modal-no').addEventListener('click', () => $('modal').classList.remove('is-open'));
  $('modal-yes').addEventListener('click', async () => {
    $('modal').classList.remove('is-open');
    if (!target) return;
    const res = await admin({ type: 'release', id: target.id, byTeacher: true });
    toast(res.ok ? res.seat + '번을 반납 처리했습니다.' : res.error, !res.ok);
  });

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
      if (!/^\d{4,8}$/.test(np)) { toast('PIN은 숫자 4~8자리로 정해 주세요.', true); return; }
      settings.pin = np;
    }
    const res = await admin({ type: 'settings', settings });
    if (!res.ok) { toast(res.error, true); return; }
    if (np) { pin = np; sessionStorage.setItem(PIN_KEY, pin); }
    toast('설정을 저장했습니다.');
    fillSettings();
  });

  $('f-csv').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const roster = Core.parseRosterCsv(await f.text());
    if (!roster.length) { toast('읽을 수 있는 학생이 없습니다. 형식을 확인하세요.', true); return; }
    if (!confirm(roster.length + '명으로 명단을 바꿀까요? 명단에 없는 학생의 좌석은 비워집니다.')) return;
    const res = await admin({ type: 'roster', roster });
    toast(res.ok ? '명단을 바꿨습니다.' : res.error, !res.ok);
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
    download('좌석기록_' + st.day + '.csv', '시각,구분,학번,이름,좌석\n' + st.log.slice().reverse().map((l) => fmtTime(l.at) + ',' + (typeName[l.type] || l.type) + ',' + l.id + ',' + l.name + ',' + l.seat).join('\n'));
  });
  $('f-reset').addEventListener('click', async () => {
    if (!confirm('오늘 배정된 모든 좌석을 비울까요?')) return;
    const res = await admin({ type: 'reset' });
    toast(res.ok ? '모든 좌석을 비웠습니다.' : res.error, !res.ok);
  });

  if (pin && (await checkPin(pin))) openMain();
  else sessionStorage.removeItem(PIN_KEY);
})();
