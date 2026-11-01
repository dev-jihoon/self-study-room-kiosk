/* 좌석 배정 핵심 로직. 브라우저와 Node 서버가 같이 쓴다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KioskCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function todayKey(d) {
    d = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function hhmm(d) {
    d = d || new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function defaultSettings() {
    return {
      pin: '0000',
      nightStart: '18:00',
      nightEnd: '22:30',
      demoMode: true,
      webhookUrl: '',
      publicUrl: ''
    };
  }

  function emptyState(roster) {
    return {
      version: 1,
      day: todayKey(),
      roster: roster || [],
      seats: {},
      log: [],
      events: [],
      settings: defaultSettings()
    };
  }

  function allSeatNumbers(layout) {
    const out = [];
    layout.blocks.forEach((b) => b.rows.forEach((r) => r.cells.forEach((c) => {
      if (typeof c === 'number') out.push(c);
    })));
    return out;
  }

  function findStudent(state, id) {
    id = String(id || '').trim();
    return state.roster.find((s) => s.id === id) || null;
  }

  function seatOf(state, id) {
    for (const k in state.seats) if (state.seats[k].id === id) return Number(k);
    return null;
  }

  function isNightTime(state, d) {
    const now = hhmm(d);
    const { nightStart, nightEnd } = state.settings;
    return nightStart <= nightEnd ? (now >= nightStart && now < nightEnd) : (now >= nightStart || now < nightEnd);
  }

  function kioskOpen(state, d) {
    return state.settings.demoMode || isNightTime(state, d);
  }

  /* 날짜가 바뀌면 좌석을 비운다. 바뀌었으면 true */
  function rollDay(state, d) {
    const k = todayKey(d);
    if (state.day === k) return false;
    state.day = k;
    state.seats = {};
    state.log = [];
    state.events = [];
    return true;
  }

  function message(name, seat) {
    return '[자기주도학습실] ' + name + ' 학생, 오늘 야간자율학습 좌석은 ' + seat + '번입니다.';
  }

  function pushLog(state, type, student, seat, d) {
    const at = (d || new Date()).toISOString();
    state.log.unshift({ at, type, id: student.id, name: student.name, seat });
    if (state.log.length > 500) state.log.length = 500;
    if (type === 'assign' || type === 'move') {
      state.events.push({ at, type, id: student.id, name: student.name, seat, message: message(student.name, seat) });
      if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
    }
  }

  /* 모든 변경은 apply 하나로 들어온다. 성공하면 {ok:true, ...}, 실패하면 {ok:false, error} */
  function apply(state, layout, action, d) {
    d = d || new Date();
    rollDay(state, d);
    const valid = new Set(allSeatNumbers(layout));

    switch (action.type) {
      case 'assign': {
        if (!kioskOpen(state, d)) return { ok: false, error: '야간자율학습 시간에만 배정할 수 있습니다.' };
        const st = findStudent(state, action.id);
        if (!st) return { ok: false, error: '등록되지 않은 학번입니다.' };
        const seat = Number(action.seat);
        if (!valid.has(seat)) return { ok: false, error: '없는 좌석입니다.' };
        const cur = state.seats[seat];
        if (cur && cur.id !== st.id) return { ok: false, error: seat + '번은 이미 사용 중입니다.' };
        const prev = seatOf(state, st.id);
        if (prev === seat) return { ok: true, seat, student: st, unchanged: true };
        if (prev !== null) delete state.seats[prev];
        state.seats[seat] = { id: st.id, name: st.name, at: d.toISOString() };
        pushLog(state, prev !== null ? 'move' : 'assign', st, seat, d);
        return { ok: true, seat, student: st, moved: prev !== null, from: prev };
      }
      case 'release': {
        const st = findStudent(state, action.id);
        if (!st) return { ok: false, error: '등록되지 않은 학번입니다.' };
        const prev = seatOf(state, st.id);
        if (prev === null) return { ok: false, error: '배정된 좌석이 없습니다.' };
        delete state.seats[prev];
        pushLog(state, action.byTeacher ? 'force-release' : 'release', st, prev, d);
        return { ok: true, seat: prev, student: st };
      }
      case 'reset': {
        state.seats = {};
        state.log = [];
        state.events = [];
        return { ok: true };
      }
      case 'settings': {
        const allowed = Object.keys(defaultSettings());
        for (const k of allowed) if (k in action.settings) state.settings[k] = action.settings[k];
        return { ok: true };
      }
      case 'roster': {
        if (!Array.isArray(action.roster)) return { ok: false, error: '명단 형식이 올바르지 않습니다.' };
        state.roster = action.roster.map((s) => ({ id: String(s.id), name: String(s.name), night: s.night !== false }));
        const ids = new Set(state.roster.map((s) => s.id));
        for (const k in state.seats) if (!ids.has(state.seats[k].id)) delete state.seats[k];
        return { ok: true };
      }
      default:
        return { ok: false, error: '알 수 없는 요청입니다.' };
    }
  }

  /* CSV: 학번,이름,야자(1/0) — 첫 줄이 머리글이면 건너뛴다 */
  function parseRosterCsv(text) {
    const out = [];
    text.split(/\r?\n/).forEach((line) => {
      const cols = line.split(',').map((c) => c.trim());
      if (cols.length < 2 || !/^\d+$/.test(cols[0])) return;
      out.push({ id: cols[0], name: cols[1], night: cols[2] === undefined || cols[2] === '' ? true : cols[2] !== '0' });
    });
    return out;
  }

  return { todayKey, hhmm, defaultSettings, emptyState, allSeatNumbers, findStudent, seatOf, isNightTime, kioskOpen, rollDay, apply, parseRosterCsv, message };
});
