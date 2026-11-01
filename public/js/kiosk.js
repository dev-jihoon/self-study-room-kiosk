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
    if (name !== 'idle' && name !== 'done') idleTimer = setTimeout(reset, 40000);
  }

  function reset() {
    current = null;
    pendingSeat = null;
    clearInterval(doneTimer);
    closeModal();
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
    else { b.className = 'badge badge--off'; b.textContent = '운영 시간 아님 (' + st.settings.nightStart + '~' + st.settings.nightEnd + ')'; }
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
    if (!st) { toast('등록되지 않은 학번입니다: ' + (id || raw), true); setInput(''); return; }
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
    $('who-name').textContent = current.name + ' 학생';
    const acts = $('who-actions');
    acts.innerHTML = '';
    if (seat !== null) {
      $('who-msg').textContent = '지금 ' + seat + '번 자리를 쓰고 있습니다.';
      if (open) acts.appendChild(button('자리 바꾸기', '', () => { renderPick(); show('pick'); }));
      acts.appendChild(button('반납하기', 'btn--danger', release));
    } else if (!open) {
      $('who-msg').textContent = '좌석 배정은 야간자율학습 시간(' + st.settings.nightStart + '~' + st.settings.nightEnd + ')에만 할 수 있습니다.';
    } else {
      $('who-msg').textContent = current.night === false ? '야간자율학습 신청 명단에 없지만 자리를 배정받을 수 있습니다.' : '오늘 앉을 자리를 골라 주세요.';
      acts.appendChild(button('자리 고르기', 'btn--primary', () => { renderPick(); show('pick'); }));
    }
    acts.appendChild(button('처음으로', '', reset));
  }

  /* 좌석 선택 */
  function renderPick() {
    if (!current) return;
    const st = store.state;
    const mine = Core.seatOf(st, current.id);
    $('pick-title').textContent = current.name + ' 학생, ' + (mine !== null ? '옮길 자리를 고르세요' : '앉을 자리를 고르세요');
    const map = window.SeatMap.render($('pick-map'), layout, st, {
      mode: 'pick',
      mine,
      onSeat(no, occ) {
        if (occ && occ.id === current.id) { toast('지금 앉아 있는 자리입니다.'); return; }
        if (occ) { toast(no + '번은 이미 사용 중입니다.', true); return; }
        pendingSeat = no;
        $('modal-title').textContent = no + '번';
        $('modal-body').textContent = '이 자리에 앉을까요?';
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
    const base = store.state.settings.publicUrl || location.href.replace(/[^/]*(\?.*)?$/, '');
    const q = new URLSearchParams({ s: seat, n: current.name, d: store.state.day, t: Core.hhmm() });
    return base.replace(/\/?$/, '/') + 'me.html?' + q.toString();
  }

  function showDone(seat, moved) {
    $('done-name').textContent = current.name + ' 학생, ' + (moved ? '자리를 옮겼습니다.' : '오늘 자리는');
    $('done-seat').textContent = seat;
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(myUrl(seat));
      qr.make();
      $('done-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) { $('done-qr').textContent = ''; }
    show('done');
    let left = 12;
    $('done-count').textContent = left + '초 뒤 처음 화면으로 돌아갑니다.';
    clearInterval(doneTimer);
    doneTimer = setInterval(() => {
      left -= 1;
      $('done-count').textContent = left + '초 뒤 처음 화면으로 돌아갑니다.';
      if (left <= 0) reset();
    }, 1000);
  }
  $('done-ok').addEventListener('click', reset);

  async function release() {
    const res = await store.dispatch({ type: 'release', id: current.id });
    if (!res.ok) { toast(res.error, true); return; }
    $('msg-title').textContent = res.seat + '번 자리를 반납했습니다';
    $('msg-body').textContent = current.name + ' 학생, 수고했습니다.';
    show('msg');
    setTimeout(reset, 3000);
  }

  /* 카메라 */
  let stopCam = null;
  let facing = localStorage.getItem('study-room-kiosk/facing') || 'user';
  async function startCam() {
    if (stopCam) { stopCam(); stopCam = null; }
    const cam = $('camera');
    cam.classList.toggle('is-mirror', facing === 'user');
    try {
      stopCam = await window.Scanner.start($('video'), (code) => {
        if (screen === 'idle') identify(code);
      }, { facing });
    } catch (e) {
      const msg = document.createElement('div');
      msg.className = 'camera__msg';
      msg.innerHTML = '카메라를 쓸 수 없습니다.<br>' + (e && e.message ? e.message : '') + '<br>학번 입력으로 진행하세요.';
      $('video').style.display = 'none';
      cam.querySelector('.camera__frame').style.display = 'none';
      cam.querySelector('.camera__hint').style.display = 'none';
      cam.appendChild(msg);
    }
  }
  $('flip').addEventListener('click', () => {
    facing = facing === 'user' ? 'environment' : 'user';
    try { localStorage.setItem('study-room-kiosk/facing', facing); } catch (e) {}
    startCam();
  });
  startCam();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
