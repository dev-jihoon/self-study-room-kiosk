/* 키오스크 화면 */
(async function () {
  'use strict';
  const Core = window.KioskCore;
  const $ = (id) => document.getElementById(id);
  const store = await window.KioskStore.open();
  const layout = store.layout;

  let current = null;      // 지금 쓰고 있는 학생
  let screen = 'idle';
  let idleTimer = null;
  let doneTimer = null;
  let inputBuf = '';
  let pendingSeat = null;

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
    closeSheet();
    stopCamera();
    setInput('');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    renderIdle();
    show('idle');
  }

  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.className = 'toast is-show';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.className = 'toast'; }, 2400);
  }

  /* 처음 화면 문구는 운영 시간에 따라 바뀐다 */
  function renderIdle() {
    const st = store.state;
    if (Core.kioskOpen(st)) {
      $('idle-title').innerHTML = '학생증을<br>찍어 주세요';
      $('idle-sub').textContent = '바코드가 카메라에 보이게 대 주세요';
    } else if (!Core.isNightDay(st)) {
      const off = Core.offDate(st);
      $('idle-title').innerHTML = '오늘은 야자가<br>없는 날이에요';
      $('idle-sub').textContent = off && off.label ? off.label + ' 때문에 쉬어요' : '반납과 외출은 언제든 돼요';
    } else {
      $('idle-title').innerHTML = '지금은 야자 시간이<br>아니에요';
      $('idle-sub').textContent = st.settings.nightStart + '부터 자리를 받을 수 있어요. 반납은 언제든 돼요.';
    }
  }

  /* 감독이 적어 둔 공지 */
  function renderNotice() {
    const n = String(store.state.settings.notice || '').trim();
    $('notice').hidden = !n;
    $('notice').textContent = n;
  }
  store.subscribe(renderNotice);
  renderNotice();

  function tick() { $('clock').textContent = Core.hhmm(); if (screen === 'idle') renderIdle(); }
  setInterval(tick, 10000);
  tick();
  renderIdle();
  store.subscribe(() => { if (screen === 'pick') renderPick(); });

  /* 학번 입력 */
  function setInput(v) {
    inputBuf = v;
    const box = $('idbox');
    box.textContent = v || '학번 5자리';
    box.classList.toggle('is-empty', !v);
    document.querySelector('.key-ok').disabled = !v;
  }
  $('numpad').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || screen !== 'idle') return;
    const k = b.dataset.k;
    if (k === 'del') setInput(inputBuf.slice(0, -1));
    else if (k === 'ok') { if (inputBuf) identify(inputBuf); }
    else if (inputBuf.length < 8) setInput(inputBuf + b.textContent);
  });
  /* USB 바코드 스캐너나 키보드도 받는다 */
  document.addEventListener('keydown', (e) => {
    if (screen !== 'idle') return;
    if (/^\d$/.test(e.key) && inputBuf.length < 8) setInput(inputBuf + e.key);
    else if (e.key === 'Backspace') setInput(inputBuf.slice(0, -1));
    else if (e.key === 'Enter') { e.preventDefault(); if (inputBuf) identify(inputBuf); }
  });

  /* 누구인지 확인한 다음 */
  function identify(raw) {
    const id = String(raw).replace(/\D/g, '');
    const st = Core.findStudent(store.state, id);
    if (!st) { setInput(''); show('idle'); toast('등록되지 않은 학번이에요'); return; }
    current = st;
    setInput('');
    const seat = Core.seatOf(store.state, st.id);
    const open = Core.kioskOpen(store.state);
    if (seat === null && open) {
      /* 지정석이 비어 있으면 한 번에 앉게 한다 */
      if (myFixedSeat() !== null) { renderWho(null, open); show('who'); return; }
      renderPick(); show('pick'); return;
    }
    renderWho(seat, open);
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

  /* 지금 학생의 지정석이 비어 있고 쓸 수 있으면 그 번호 */
  function myFixedSeat() {
    const st = store.state;
    const n = current && current.seat;
    if (!n || st.seats[n] || Core.isClosed(st, n)) return null;
    return Core.allSeatNumbers(layout).indexOf(n) !== -1 ? n : null;
  }

  async function sitAt(seat) {
    const res = await store.dispatch({ type: 'assign', id: current.id, seat });
    if (!res.ok) { toast(res.error); renderPick(); show('pick'); return; }
    showDone(seat, res.moved);
  }

  function renderWho(seat, open) {
    const acts = $('who-actions');
    acts.innerHTML = '';
    acts.className = 'btn-col';
    const fixed = seat === null && open ? myFixedSeat() : null;
    if (fixed !== null) {
      $('who-title').innerHTML = esc(current.name) + '님 자리는<br>' + fixed + '번이에요';
      $('who-sub').textContent = '';
      acts.appendChild(button(fixed + '번에 앉을게요', 'btn--primary', () => sitAt(fixed)));
      acts.appendChild(button('다른 자리 고를게요', '', () => { renderPick(); show('pick'); }));
    } else if (seat !== null && store.state.seats[seat].out) {
      $('who-title').innerHTML = esc(current.name) + '님,<br>다녀왔어요?';
      $('who-sub').textContent = seat + '번 자리는 그대로 있어요';
      acts.appendChild(button('돌아왔어요', 'btn--primary', () => outBack('back', seat)));
      acts.appendChild(button('반납하기', '', release));
    } else if (seat !== null) {
      $('who-title').innerHTML = esc(current.name) + '님은 지금<br>' + seat + '번에 앉아 있어요';
      $('who-sub').textContent = '';
      acts.appendChild(button('반납하기', 'btn--primary', release));
      acts.appendChild(button('잠깐 나갈게요', '', () => outBack('out', seat)));
      if (open) acts.appendChild(button('자리 바꾸기', '', () => { renderPick(); show('pick'); }));
    } else {
      $('who-title').innerHTML = '지금은 야자 시간이<br>아니에요';
      $('who-sub').textContent = store.state.settings.nightStart + '부터 자리를 받을 수 있어요';
    }
  }
  $('who-home').addEventListener('click', reset);

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* 자리 고르기 */
  function renderPick() {
    if (!current) return;
    const st = store.state;
    const mine = Core.seatOf(st, current.id);
    $('pick-title').textContent = current.name + '님, ' + (mine !== null ? '어디로 옮길까요?' : '어디에 앉을까요?');
    const map = window.SeatMap.render($('pick-map'), layout, st, {
      mode: 'pick',
      mine,
      reserved: Core.reservations(st),
      me: current.id,
      lockReserved: !!st.settings.fixedOnly,
      onSeat(no, occ) {
        if (occ && occ.id === current.id) { toast('지금 앉아 있는 자리예요'); return; }
        if (occ) { toast('이미 누가 앉아 있어요'); return; }
        pendingSeat = no;
        $('sheet-title').textContent = no + '번 자리' + (mine !== null ? '로 옮길까요?' : '에 앉을까요?');
        $('sheet-sub').textContent = mine !== null ? '지금 앉은 ' + mine + '번은 비워져요' : '';
        $('sheet-sub').hidden = mine === null;
        $('sheet-yes').textContent = mine !== null ? '옮길게요' : '앉을게요';
        $('sheet').classList.add('is-open');
      }
    });
    requestAnimationFrame(() => window.SeatMap.fit($('pick-map'), map));
  }
  window.addEventListener('resize', () => { if (screen === 'pick') renderPick(); });
  $('pick-cancel').addEventListener('click', reset);

  function closeSheet() { $('sheet').classList.remove('is-open'); }
  $('sheet-no').addEventListener('click', () => { pendingSeat = null; closeSheet(); });
  $('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') { pendingSeat = null; closeSheet(); } });
  $('sheet-yes').addEventListener('click', async () => {
    const seat = pendingSeat;
    closeSheet();
    if (seat === null || !current) return;
    const res = await store.dispatch({ type: 'assign', id: current.id, seat });
    if (!res.ok) { toast(res.error); renderPick(); return; }
    showDone(seat, res.moved);
  });

  /* 내 자리 보기 주소 */
  function myUrl(seat) {
    const base = store.state.settings.publicUrl || location.href.replace(/[^/]*(\?.*)?(#.*)?$/, '');
    const q = new URLSearchParams({ s: seat, n: current.name, d: store.state.day, t: Core.hhmm() });
    return base.replace(/\/?$/, '/') + 'me.html?' + q.toString();
  }

  function countdown(sec) {
    let left = sec;
    const draw = () => { $('done-count').textContent = left + '초 뒤에 처음 화면으로 돌아가요'; };
    draw();
    clearInterval(doneTimer);
    doneTimer = setInterval(() => { left -= 1; draw(); if (left <= 0) reset(); }, 1000);
  }

  function showDone(seat, moved) {
    $('done-title').textContent = seat + '번 자리로 ' + (moved ? '옮겼어요' : '배정했어요');
    $('done-sub').hidden = true;
    $('done-qr-box').hidden = false;
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(myUrl(seat));
      qr.make();
      $('done-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) { $('done-qr-box').hidden = true; }
    show('done');
    countdown(10);
  }
  $('done-ok').addEventListener('click', reset);

  async function release() {
    const res = await store.dispatch({ type: 'release', id: current.id });
    if (!res.ok) { toast(res.error); return; }
    $('done-title').textContent = res.seat + '번 자리를 반납했어요';
    $('done-sub').textContent = '오늘도 수고했어요';
    $('done-sub').hidden = false;
    $('done-qr-box').hidden = true;
    show('done');
    countdown(5);
  }

  /* 외출, 돌아옴: 자리는 그대로 둔다 */
  async function outBack(type, seat) {
    const res = await store.dispatch({ type, id: current.id });
    if (!res.ok) { toast(res.error); return; }
    $('done-title').textContent = type === 'out' ? '다녀오세요' : '어서 와요';
    $('done-sub').textContent = type === 'out' ? seat + '번 자리는 그대로 둘게요' : seat + '번 자리 그대로예요';
    $('done-sub').hidden = false;
    $('done-qr-box').hidden = true;
    show('done');
    countdown(5);
  }

  /* 카메라: 켜기 버튼을 눌렀을 때만 켠다 */
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
    $('scan-msg').textContent = '';
    try {
      const stop = await window.Scanner.start($('video'), (code) => {
        if (screen !== 'scan') return;
        stopCamera();
        identify(code);
      }, { facing });
      if (token !== camToken) { stop(); return; }
      stopCam = stop;
    } catch (e) {
      if (token !== camToken) return;
      view.classList.add('is-error');
      $('scan-msg').textContent = cameraError(e);
    }
  }

  function cameraError(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return '카메라를 쓸 수 없어요. 브라우저에서 카메라를 허용하거나 학번으로 해 주세요.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return '이쪽 카메라를 찾지 못했어요. 카메라를 바꿔 보세요.';
    if (n === 'NotReadableError') return '다른 앱이 카메라를 쓰고 있어요. 잠시 뒤에 다시 해 주세요.';
    return '카메라를 켜지 못했어요. 학번으로 해 주세요.';
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
