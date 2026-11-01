/* 키오스크 화면 */
(async function () {
  'use strict';
  const Core = window.KioskCore;
  const $ = (id) => document.getElementById(id);
  const store = await window.KioskStore.open();
  const layout = store.layout;

  let current = null;      // 지금 응대 중인 학생
  let screen = 'idle';
  let idleTimer = null;
  let doneTimer = null;
  let inputBuf = '';
  let pendingSeat = null;

  /* 화면 전환 */
  function show(name) {
    screen = name;
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('is-active', s.id === 's-' + name));
    clearTimeout(idleTimer);
    if (name === 'scan') idleTimer = setTimeout(cancelScan, 30000);
    else if (name !== 'idle' && name !== 'done') idleTimer = setTimeout(reset, 40000);
  }

  function reset() {
    current = null;
    pendingSeat = null;
    clearInterval(doneTimer);
    closeModal();
    stopCamera();
    setInput('');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    show('idle');
  }

  function toast(text, isError) {
    const t = $('toast');
    t.textContent = text;
    t.className = 'toast is-show' + (isError ? ' toast--error' : '');
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.className = 'toast'; }, 2600);
  }

  /* 상단 시계와 상태 */
  function tick() {
    const now = new Date();
    $('clock').textContent = Core.hhmm(now);
    const st = store.state;
    const b = $('status');
    if (st.settings.demoMode) { b.className = 'badge badge--demo'; b.textContent = '시연 모드'; }
    else if (Core.isNightTime(st, now)) { b.className = 'badge'; b.textContent = '야자 운영 중'; }
    else { b.className = 'badge badge--off'; b.textContent = '운영 시간 외 (' + st.settings.nightStart + '~' + st.settings.nightEnd + ')'; }
  }
  setInterval(tick, 5000);
  tick();
  store.subscribe(() => { tick(); if (screen === 'pick') renderPick(); });

  /* 제목을 2초 누르면 감독 화면 */
  (function () {
    let h;
    const t = $('title');
    t.addEventListener('pointerdown', () => { h = setTimeout(() => { location.href = 'admin.html'; }, 2000); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((e) => t.addEventListener(e, () => clearTimeout(h)));
  })();

  /* 학번 입력 */
  function setInput(v) {
    inputBuf = v;
    const box = $('idbox');
    box.textContent = v || '학번 5자리';
    box.classList.toggle('is-empty', !v);
  }
  $('numpad').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || screen !== 'idle') return;
    const k = b.dataset.k;
    if (k === 'del') setInput(inputBuf.slice(0, -1));
    else if (k === 'ok') { if (inputBuf) identify(inputBuf); }
    else if (inputBuf.length < 8) setInput(inputBuf + b.textContent);
  });
  /* USB 바코드 스캐너나 키보드 입력도 받는다 */
  document.addEventListener('keydown', (e) => {
    if (screen !== 'idle') return;
    if (/^\d$/.test(e.key) && inputBuf.length < 8) setInput(inputBuf + e.key);
    else if (e.key === 'Backspace') setInput(inputBuf.slice(0, -1));
    else if (e.key === 'Enter') { e.preventDefault(); if (inputBuf) identify(inputBuf); }
  });

  /* 학생 확인 */
  function identify(raw) {
    const id = String(raw).replace(/\D/g, '');
    const st = Core.findStudent(store.state, id);
    if (!st) { toast('등록되지 않은 학번: ' + (id || raw), true); setInput(''); show('idle'); return; }
    current = st;
    setInput('');
    renderWho();
    show('who');
  }

  function button(text, cls, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ' + (cls || '');
    b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  }

  function renderWho() {
    const st = store.state;
    const seat = Core.seatOf(st, current.id);
    const open = Core.kioskOpen(st);
    $('who-id').textContent = current.id;
    $('who-name').textContent = current.name;
    const acts = $('who-actions');
    acts.innerHTML = '';
    if (seat !== null) {
      $('who-msg').textContent = '현재 ' + seat + '번 사용 중';
      if (open) acts.appendChild(button('자리 변경', '', () => { show('pick'); renderPick(); }));
      acts.appendChild(button('반납', 'btn--danger', release));
    } else if (!open) {
      $('who-msg').textContent = '야자 시간(' + st.settings.nightStart + '~' + st.settings.nightEnd + ')에만 배정 가능';
    } else {
      $('who-msg').textContent = current.night === false ? '야자 신청 명단에 없음, 배정은 가능' : '오늘 배정된 자리 없음';
      acts.appendChild(button('자리 선택', 'btn--primary', () => { show('pick'); renderPick(); }));
    }
    acts.appendChild(button('처음으로', '', reset));
  }

  /* 자리 선택 */
  function renderPick() {
    if (!current) return;
    const st = store.state;
    const mine = Core.seatOf(st, current.id);
    $('pick-who').textContent = current.name + ' ' + current.id + (mine !== null ? ', 현재 ' + mine + '번' : '');
    const map = window.SeatMap.render($('pick-map'), layout, st, {
      mode: 'pick',
      mine,
      onSeat(no, occ) {
        if (occ && occ.id === current.id) { toast('현재 자리'); return; }
        if (occ) { toast(no + '번은 사용 중', true); return; }
        pendingSeat = no;
        $('modal-title').textContent = no + '번';
        $('modal-body').textContent = current.name + (mine !== null ? ', ' + mine + '번에서 이동' : '');
        $('modal-yes').textContent = mine !== null ? '이동' : '배정';
        $('modal').classList.add('is-open');
      }
    });
    requestAnimationFrame(() => window.SeatMap.fit($('pick-map'), map));
  }
  window.addEventListener('resize', () => { if (screen === 'pick') renderPick(); });
  $('pick-cancel').addEventListener('click', reset);

  function closeModal() { $('modal').classList.remove('is-open'); }
  $('modal-no').addEventListener('click', () => { pendingSeat = null; closeModal(); });
  $('modal-yes').addEventListener('click', async () => {
    const seat = pendingSeat;
    closeModal();
    if (seat === null || !current) return;
    const res = await store.dispatch({ type: 'assign', id: current.id, seat });
    if (!res.ok) { toast(res.error, true); renderPick(); return; }
    showDone(seat, res.moved);
  });

  /* 내 자리 확인 주소 */
  function myUrl(seat) {
    const base = store.state.settings.publicUrl || location.href.replace(/[^/]*(\?.*)?(#.*)?$/, '');
    const q = new URLSearchParams({ s: seat, n: current.name, d: store.state.day, t: Core.hhmm() });
    return base.replace(/\/?$/, '/') + 'me.html?' + q.toString();
  }

  function showDone(seat, moved) {
    $('done-name').textContent = current.name + (moved ? ', 자리 이동 완료' : ', 배정 완료');
    $('done-seat').textContent = seat;
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(myUrl(seat));
      qr.make();
      $('done-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) { $('done-qr').textContent = ''; }
    show('done');
    let left = 12;
    $('done-count').textContent = left + '초 후 처음 화면';
    clearInterval(doneTimer);
    doneTimer = setInterval(() => {
      left -= 1;
      $('done-count').textContent = left + '초 후 처음 화면';
      if (left <= 0) reset();
    }, 1000);
  }
  $('done-ok').addEventListener('click', reset);

  async function release() {
    const res = await store.dispatch({ type: 'release', id: current.id });
    if (!res.ok) { toast(res.error, true); return; }
    $('msg-title').textContent = res.seat + '번 반납 완료';
    $('msg-body').textContent = current.name;
    show('msg');
    setTimeout(reset, 2500);
  }

  /* 카메라: 바코드 인식 버튼을 눌렀을 때만 켠다 */
  let stopCam = null;
  let camToken = 0;
  let facing = 'user';
  try { facing = localStorage.getItem('study-room-kiosk/facing') || 'user'; } catch (e) {}

  function stopCamera() {
    camToken += 1;
    if (stopCam) { try { stopCam(); } catch (e) {} stopCam = null; }
  }

  async function startCamera() {
    stopCamera();
    const token = camToken;
    const view = $('camera');
    view.classList.toggle('is-mirror', facing === 'user');
    view.classList.remove('is-error');
    $('scan-msg').textContent = '카메라 켜는 중';
    try {
      const stop = await window.Scanner.start($('video'), (code) => {
        if (screen !== 'scan') return;
        stopCamera();
        identify(code);
      }, { facing });
      if (token !== camToken) { stop(); return; }   // 그새 취소되었으면 바로 끈다
      stopCam = stop;
      $('scan-msg').textContent = '학생증 바코드를 네모 안에';
    } catch (e) {
      if (token !== camToken) return;
      view.classList.add('is-error');
      $('scan-msg').textContent = cameraError(e);
    }
  }

  function cameraError(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return '카메라 권한이 없음. 브라우저 설정에서 카메라를 허용하거나 학번으로 입력';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return '이 방향의 카메라가 없음. 카메라 전환을 눌러 보거나 학번으로 입력';
    if (n === 'NotReadableError') return '다른 앱이 카메라를 쓰는 중. 잠시 후 다시 시도';
    return (e && e.message) || '카메라를 켜지 못함. 학번으로 입력';
  }

  function cancelScan() { stopCamera(); show('idle'); }

  $('scan-open').addEventListener('click', () => { show('scan'); startCamera(); });
  $('scan-cancel').addEventListener('click', cancelScan);
  $('scan-flip').addEventListener('click', () => {
    facing = facing === 'user' ? 'environment' : 'user';
    try { localStorage.setItem('study-room-kiosk/facing', facing); } catch (e) {}
    startCamera();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && screen === 'scan') cancelScan(); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
