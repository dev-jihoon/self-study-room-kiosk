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

  /* 기본 명단 파일이 바뀌었는지 알아보는 짧은 표식 */
  function rosterTag(roster) {
    const str = JSON.stringify(roster || []);
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return 'default:' + (h >>> 0).toString(36);
  }

  /* 기본 명단을 쓰는 중인데 명단 파일이 바뀌었으면 새 명단으로 맞춘다. 바꿨으면 true */
  function syncDefaultRoster(state, roster) {
    if (state.rosterTag === 'custom') return false;
    const tag = rosterTag(roster);
    if (state.rosterTag === tag) return false;
    state.roster = roster.map((s) => ({ id: String(s.id), name: String(s.name), night: s.night !== false }));
    state.rosterTag = tag;
    const byId = new Map(state.roster.map((s) => [s.id, s]));
    for (const k in state.seats) {
      const st = byId.get(state.seats[k].id);
      if (st) state.seats[k].name = st.name; else delete state.seats[k];
    }
    state.log.forEach((l) => { const st = byId.get(l.id); if (st) l.name = st.name; });
    return true;
  }

  function emptyState(roster) {
    return {
      version: 1,
      day: todayKey(),
      rosterTag: rosterTag(roster),
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

  function message(name, seat, d) {
    return '[자기주도학습실] ' + name + '님, 오늘 야자 자리는 ' + seat + '번이에요. (' + hhmm(d) + ' 배정)';
  }

  function pushLog(state, type, student, seat, d, by, from) {
    const at = (d || new Date()).toISOString();
    state.log.unshift({ at, type, id: student.id, name: student.name, seat, by: by || 'kiosk', from: from === undefined ? null : from });
    if (state.log.length > 500) state.log.length = 500;
    if (type === 'assign' || type === 'move') {
      state.events.push({ at, type, id: student.id, name: student.name, seat, message: message(student.name, seat, d) });
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
        if (!action.byTeacher && !kioskOpen(state, d)) return { ok: false, error: '지금은 야자 시간이 아니에요' };
        const st = findStudent(state, action.id);
        if (!st) return { ok: false, error: '등록되지 않은 학번이에요' };
        const seat = Number(action.seat);
        if (!valid.has(seat)) return { ok: false, error: '없는 자리예요' };
        const cur = state.seats[seat];
        if (cur && cur.id !== st.id) return { ok: false, error: seat + '번은 이미 누가 앉아 있어요' };
        const prev = seatOf(state, st.id);
        if (prev === seat) return { ok: true, seat, student: st, unchanged: true };
        if (prev !== null) delete state.seats[prev];
        state.seats[seat] = { id: st.id, name: st.name, at: d.toISOString() };
        pushLog(state, prev !== null ? 'move' : 'assign', st, seat, d, action.byTeacher ? 'teacher' : 'kiosk', prev);
        return { ok: true, seat, student: st, moved: prev !== null, from: prev };
      }
      case 'release': {
        const st = findStudent(state, action.id);
        if (!st) return { ok: false, error: '등록되지 않은 학번이에요' };
        const prev = seatOf(state, st.id);
        if (prev === null) return { ok: false, error: '배정된 자리가 없어요' };
        delete state.seats[prev];
        pushLog(state, 'release', st, prev, d, action.byTeacher ? 'teacher' : 'kiosk');
        return { ok: true, seat: prev, student: st };
      }
      case 'demo-fill': {
        /* 시연용: 아직 자리가 없는 학생 일부를 지난 90분 사이에 배정된 것처럼 채운다 */
        const free = allSeatNumbers(layout).filter((n) => !state.seats[n]);
        const waiting = state.roster.filter((s) => seatOf(state, s.id) === null);
        let seed = waiting.length * 7919 + free.length;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        const picks = waiting.filter(() => rnd() < 0.8);
        const times = picks.map(() => d.getTime() - Math.floor(rnd() * 90 * 60000)).sort((a, b) => a - b);
        picks.forEach((st, i) => {
          if (!free.length) return;
          const seat = free.splice(Math.floor(rnd() * free.length), 1)[0];
          const at = new Date(times[i]);
          state.seats[seat] = { id: st.id, name: st.name, at: at.toISOString() };
          pushLog(state, 'assign', st, seat, at, 'kiosk');
        });
        state.log.sort((a, b) => (a.at < b.at ? 1 : -1));
        state.events.sort((a, b) => (a.at < b.at ? -1 : 1));
        return { ok: true, count: picks.length };
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
        if (!Array.isArray(action.roster)) return { ok: false, error: '명단 형식이 맞지 않아요' };
        state.roster = action.roster.map((s) => ({ id: String(s.id), name: String(s.name), night: s.night !== false }));
        state.rosterTag = 'custom';
        const ids = new Set(state.roster.map((s) => s.id));
        for (const k in state.seats) if (!ids.has(state.seats[k].id)) delete state.seats[k];
        return { ok: true };
      }
      default:
        return { ok: false, error: '알 수 없는 요청이에요' };
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

  return { todayKey, hhmm, defaultSettings, emptyState, rosterTag, syncDefaultRoster, allSeatNumbers, findStudent, seatOf, isNightTime, kioskOpen, rollDay, apply, parseRosterCsv, message };
});
