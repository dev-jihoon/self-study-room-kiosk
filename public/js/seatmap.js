/* 좌석 배치도 그리기 */
(function () {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /*
   opts.mode: 'pick' (키오스크 선택), 'admin' (감독 현황), 'view' (내 자리)
   opts.mine: 강조할 좌석 번호
   opts.onSeat(no): 좌석을 눌렀을 때
   opts.reserved: { 자리: {id, name} } 오늘 주인이 정해진 지정석 (빈자리일 때만 표시)
   opts.me: 키오스크에서 지금 쓰는 학생 학번 (자기 지정석은 고를 수 있다)
   opts.lockReserved: 남의 지정석은 못 누르게 한다
  */
  function render(container, layout, state, opts) {
    opts = opts || {};
    container.innerHTML = '';
    const map = el('div', 'seatmap seatmap--' + (opts.mode || 'view'));

    const closed = new Set((state.settings && state.settings.closedSeats) || []);
    layout.blocks.forEach((block) => {
      const b = el('div', 'seat-block');
      block.rows.forEach((row) => {
        const r = el('div', 'seat-row');
        row.cells.forEach((c) => {
          if (c === 'P') { r.appendChild(el('div', 'seat seat--pillar', '기둥')); return; }
          if (c === null) { r.appendChild(el('div', 'seat seat--gap')); return; }
          const occ = state.seats[c];
          const isClosed = !occ && closed.has(c);
          const res = !occ && !isClosed && opts.reserved ? opts.reserved[c] : null;
          const othersSeat = res && res.id !== opts.me;
          /* 막아 둔 자리와 남의 지정석은 키오스크에서 누를 수 없고, 감독 화면에서는 누를 수 있다 */
          const clickable = opts.onSeat && !(opts.mode !== 'admin' && (isClosed || (othersSeat && opts.lockReserved)));
          const s = el(clickable ? 'button' : 'div', 'seat');
          s.dataset.seat = c;
          s.appendChild(el('span', 'seat__no', String(c)));
          if (occ) {
            s.classList.add('seat--taken');
            if (occ.out) s.classList.add('seat--out');
            if (opts.mode === 'admin') {
              s.appendChild(el('span', 'seat__name', occ.name));
              if (occ.out) s.appendChild(el('span', 'seat__tag', '외출'));
            }
          } else if (isClosed) {
            s.classList.add('seat--closed');
            s.appendChild(el('span', 'seat__tag', '막힘'));
          } else if (res) {
            s.classList.add('seat--free', 'seat--reserved');
            if (opts.mode === 'admin') s.appendChild(el('span', 'seat__name seat__name--ghost', res.name));
            else if (!othersSeat) { s.classList.add('seat--yours'); s.appendChild(el('span', 'seat__tag', '내 지정석')); }
            else if (opts.lockReserved) s.appendChild(el('span', 'seat__tag', '지정석'));
          } else {
            s.classList.add('seat--free');
          }
          if (opts.mine === c) s.classList.add('seat--mine');
          if (opts.decorate) opts.decorate(s, c, occ || null);
          if (clickable) {
            s.type = 'button';
            s.addEventListener('click', () => opts.onSeat(c, occ || null));
          }
          r.appendChild(s);
        });
        r.appendChild(el('div', 'seat-row__label', row.label));
        b.appendChild(r);
      });
      map.appendChild(b);
    });

    const door = el('div', 'seatmap__door', '출입문');
    map.appendChild(door);
    container.appendChild(map);
    return map;
  }

  /* 배치도를 상자 크기에 맞게 키우거나 줄인다 (크롬의 zoom 사용) */
  function fit(container, map, maxZoom) {
    map.style.zoom = 1;
    const w = map.scrollWidth, h = map.scrollHeight;
    const cw = container.clientWidth, ch = container.clientHeight;
    if (!w || !h || !cw || !ch) return;
    const z = Math.min(cw / w, ch / h, maxZoom || 1.6);
    map.style.zoom = Math.max(0.5, Math.floor(z * 100) / 100);
  }

  window.SeatMap = { render, fit };
})();
