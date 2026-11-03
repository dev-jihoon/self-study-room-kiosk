/* 좌석 배정 핵심 로직. 브라우저와 Node 서버가 같이 쓴다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KioskCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 감독만 할 수 있는 요청 (byTeacher가 붙은 배정, 반납, 외출도 감독 권한이 필요) */
  const ADMIN_TYPES = new Set(['reset', 'settings', 'roster', 'roster-import', 'student-save', 'student-delete', 'night-set', 'seat-close', 'demo-fill', 'change-pin']);
  const LOG_MAX = 2000;

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
      pin: '0000',          // 브라우저 저장소 모드에서만 쓴다. 서버는 해시로 따로 보관
      nightStart: '18:00',
      nightEnd: '22:30',
      days: [1, 2, 3, 4, 5], // 야자 하는 요일 (0 일요일 ~ 6 토요일)
      demoMode: true,
      closedSeats: [],       // 고장 등으로 막아 둔 자리
      autoLockMin: 10,       // 감독 화면을 이 시간 동안 안 만지면 잠근다 (0이면 안 잠금)
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

  function cleanStudent(s) {
    return { id: String(s.id).trim(), name: String(s.name).trim(), night: s.night !== false };
  }

  /* 자리와 기록에 남은 이름을 명단에 맞춘다. 명단에서 빠진 학생의 자리는 비운다 */
  function syncSeats(state) {
    const byId = new Map(state.roster.map((s) => [s.id, s]));
    for (const k in state.seats) {
      const st = byId.get(state.seats[k].id);
      if (st) state.seats[k].name = st.name; else delete state.seats[k];
    }
    state.log.forEach((l) => { const st = byId.get(l.id); if (st) l.name = st.name; });
  }

  /* 기본 명단을 쓰는 중인데 명단 파일이 바뀌었으면 새 명단으로 맞춘다. 바꿨으면 true */
  function syncDefaultRoster(state, roster) {
    if (state.rosterTag === 'custom') return false;
    const tag = rosterTag(roster);
    if (state.rosterTag === tag) return false;
    state.roster = roster.map(cleanStudent);
    state.rosterTag = tag;
    syncSeats(state);
    return true;
  }

  function emptyState(roster) {
    return {
      version: 1,
      day: todayKey(),
      rosterTag: rosterTag(roster),
      roster: (roster || []).map(cleanStudent),
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

  function isClosed(state, seat) {
    return (state.settings.closedSeats || []).indexOf(Number(seat)) !== -1;
  }

  function isNightDay(state, d) {
    const days = state.settings.days;
    return !Array.isArray(days) || days.indexOf((d || new Date()).getDay()) !== -1;
  }

  function isNightTime(state, d) {
    const now = hhmm(d);
    const { nightStart, nightEnd } = state.settings;
    return nightStart <= nightEnd ? (now >= nightStart && now < nightEnd) : (now >= nightStart || now < nightEnd);
  }

  function kioskOpen(state, d) {
    return state.settings.demoMode || (isNightDay(state, d) && isNightTime(state, d));
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

  function pushLog(state, type, student, seat, d, by, from, note) {
    const at = (d || new Date()).toISOString();
    const entry = { at, type, id: student.id, name: student.name, seat, by: by || 'kiosk', from: from === undefined ? null : from };
    if (note) entry.note = note;
    state.log.unshift(entry);
    if (state.log.length > LOG_MAX) state.log.length = LOG_MAX;
    if (type === 'assign' || type === 'move') {
      state.events.push({ at, type, id: student.id, name: student.name, seat, message: message(student.name, seat, d) });
      if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
    }
  }

  /* 학번은 숫자 4~12자리, 이름은 1~30자 */
  function checkStudent(s) {
    const id = String(s && s.id !== undefined ? s.id : '').trim();
    const name = String(s && s.name !== undefined ? s.name : '').trim();
    if (!/^\d{4,12}$/.test(id)) return '학번은 숫자 4~12자리로 넣어 주세요';
    if (!name) return '이름을 넣어 주세요';
    if (name.length > 30) return '이름은 30자까지 넣을 수 있어요';
    return '';
  }

  /* 명단 전체를 검사한다. 문제가 있으면 첫 번째 문제를 돌려준다 */
  function checkRoster(list) {
    if (!Array.isArray(list)) return '명단 형식이 맞지 않아요';
    const seen = new Set();
    for (const s of list) {
      const err = checkStudent(s);
      if (err) return (s && s.id ? s.id + ': ' : '') + err;
      const id = String(s.id).trim();
      if (seen.has(id)) return id + ' 학번이 두 번 들어 있어요';
      seen.add(id);
    }
    return '';
  }

  /* 모든 변경은 apply 하나로 들어온다. 성공하면 {ok:true, ...}, 실패하면 {ok:false, error} */
  function apply(state, layout, action, d) {
    d = d || new Date();
    rollDay(state, d);
    const valid = new Set(allSeatNumbers(layout));
    const by = action.byTeacher ? 'teacher' : 'kiosk';

    switch (action.type) {
      case 'assign': {
        if (!action.byTeacher && !kioskOpen(state, d)) return { ok: false, error: '지금은 야자 시간이 아니에요' };
        const st = findStudent(state, action.id);
        if (!st) return { ok: false, error: '등록되지 않은 학번이에요' };
        const seat = Number(action.seat);
        if (!valid.has(seat)) return { ok: false, error: '없는 자리예요' };
        if (isClosed(state, seat)) return { ok: false, error: seat + '번은 지금 쓸 수 없는 자리예요' };
        const cur = state.seats[seat];
        if (cur && cur.id !== st.id) return { ok: false, error: seat + '번은 이미 누가 앉아 있어요' };
        const prev = seatOf(state, st.id);
        if (prev === seat) return { ok: true, seat, student: st, unchanged: true };
        /* 자리를 옮겨도 처음 들어온 시각은 그대로 둔다 */
        const first = prev !== null ? state.seats[prev].at : d.toISOString();
        if (prev !== null) delete state.seats[prev];
        state.seats[seat] = { id: st.id, name: st.name, at: first };
        pushLog(state, prev !== null ? 'move' : 'assign', st, seat, d, by, prev);
        return { ok: true, seat, student: st, moved: prev !== null, from: prev };
      }
      case 'release': {
        const st = findStudent(state, action.id);
        if (!st) return { ok: false, error: '등록되지 않은 학번이에요' };
        const prev = seatOf(state, st.id);
        if (prev === null) return { ok: false, error: '배정된 자리가 없어요' };
        delete state.seats[prev];
        const early = action.byTeacher && action.reason === 'early';
        pushLog(state, 'release', st, prev, d, by, undefined, early ? 'early' : '');
        return { ok: true, seat: prev, student: st, early };
      }
      /* 외출: 자리는 그대로 두고 잠깐 나갔다고 표시한다 */
      case 'out':
      case 'back': {
        const st = findStudent(state, action.id);
        if (!st) return { ok: false, error: '등록되지 않은 학번이에요' };
        const seat = seatOf(state, st.id);
        if (seat === null) return { ok: false, error: '배정된 자리가 없어요' };
        const cur = state.seats[seat];
        if (action.type === 'out') {
          if (cur.out) return { ok: false, error: '이미 외출 중이에요' };
          cur.out = d.toISOString();
        } else {
          if (!cur.out) return { ok: false, error: '외출 중이 아니에요' };
          delete cur.out;
        }
        pushLog(state, action.type, st, seat, d, by);
        return { ok: true, seat, student: st };
      }
      case 'demo-fill': {
        /* 시연용: 야자 신청한 학생 중 아직 자리가 없는 학생 일부를 지난 90분 사이에 배정된 것처럼 채운다 */
        const free = allSeatNumbers(layout).filter((n) => !state.seats[n] && !isClosed(state, n));
        const waiting = state.roster.filter((s) => s.night !== false && seatOf(state, s.id) === null);
        let seed = waiting.length * 7919 + free.length;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        const picks = waiting.filter(() => rnd() < 0.8);
        const times = picks.map(() => d.getTime() - Math.floor(rnd() * 90 * 60000)).sort((a, b) => a - b);
        let count = 0;
        picks.forEach((st, i) => {
          if (!free.length) return;
          const seat = free.splice(Math.floor(rnd() * free.length), 1)[0];
          const at = new Date(times[i]);
          state.seats[seat] = { id: st.id, name: st.name, at: at.toISOString() };
          pushLog(state, 'assign', st, seat, at, 'kiosk');
          count += 1;
        });
        state.log.sort((a, b) => (a.at < b.at ? 1 : -1));
        state.events.sort((a, b) => (a.at < b.at ? -1 : 1));
        return { ok: true, count };
      }
      case 'reset': {
        state.seats = {};
        state.log = [];
        state.events = [];
        return { ok: true };
      }
      case 'settings': {
        const s = action.settings || {};
        if ('nightStart' in s && !/^\d{2}:\d{2}$/.test(s.nightStart)) return { ok: false, error: '시작 시각을 확인해 주세요' };
        if ('nightEnd' in s && !/^\d{2}:\d{2}$/.test(s.nightEnd)) return { ok: false, error: '끝나는 시각을 확인해 주세요' };
        if ('days' in s && (!Array.isArray(s.days) || s.days.some((x) => !(x >= 0 && x <= 6)))) return { ok: false, error: '요일을 확인해 주세요' };
        if ('autoLockMin' in s && !(s.autoLockMin >= 0 && s.autoLockMin <= 240)) return { ok: false, error: '자동 잠금 시간을 확인해 주세요' };
        /* PIN과 막힌 자리는 여기서 바꾸지 않는다 (change-pin, seat-close로만) */
        for (const k of Object.keys(defaultSettings())) {
          if (k === 'pin' || k === 'closedSeats') continue;
          if (k in s) state.settings[k] = s[k];
        }
        return { ok: true };
      }
      case 'seat-close': {
        const seat = Number(action.seat);
        if (!valid.has(seat)) return { ok: false, error: '없는 자리예요' };
        const list = (state.settings.closedSeats || []).filter((n) => n !== seat);
        if (action.closed) {
          if (state.seats[seat]) return { ok: false, error: '누가 앉아 있는 자리는 막을 수 없어요' };
          list.push(seat);
        }
        state.settings.closedSeats = list.sort((a, b) => a - b);
        return { ok: true, seat, closed: !!action.closed };
      }
      /* 예전 방식: 명단 전체 바꾸기 */
      case 'roster':
        return apply(state, layout, { type: 'roster-import', mode: 'replace', rows: action.roster }, d);
      /* 명단 불러오기. mode: replace(전체 바꾸기), merge(더하기), night(야자 신청만 바꾸기) */
      case 'roster-import': {
        const rows = action.rows;
        if (!Array.isArray(rows) || !rows.length) return { ok: false, error: '불러올 학생이 없어요' };
        if (action.mode === 'night') {
          const ids = new Set(rows.map((r) => String(r.id).trim()));
          let on = 0;
          state.roster.forEach((s) => { s.night = ids.has(s.id); if (s.night) on += 1; });
          const unknown = [...ids].filter((id) => !state.roster.some((s) => s.id === id)).length;
          state.rosterTag = 'custom';
          return { ok: true, night: on, unknown };
        }
        const err = checkRoster(rows);
        if (err) return { ok: false, error: err };
        const clean = rows.map(cleanStudent);
        if (action.mode === 'merge') {
          const byId = new Map(state.roster.map((s) => [s.id, s]));
          let added = 0, changed = 0;
          clean.forEach((s) => {
            const cur = byId.get(s.id);
            if (!cur) { state.roster.push(s); added += 1; return; }
            if (cur.name !== s.name || cur.night !== s.night) { cur.name = s.name; cur.night = s.night; changed += 1; }
          });
          state.roster.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
          state.rosterTag = 'custom';
          syncSeats(state);
          return { ok: true, added, changed };
        }
        if (action.mode !== 'replace') return { ok: false, error: '불러오는 방식을 골라 주세요' };
        const before = state.roster.length;
        state.roster = clean;
        state.rosterTag = 'custom';
        syncSeats(state);
        return { ok: true, count: clean.length, before };
      }
      case 'student-save': {
        const s = action.student || {};
        const err = checkStudent(s);
        if (err) return { ok: false, error: err };
        const c = cleanStudent(s);
        const cur = findStudent(state, c.id);
        if (action.isNew) {
          if (cur) return { ok: false, error: c.id + ' 학번은 이미 ' + cur.name + '님이 쓰고 있어요' };
          state.roster.push(c);
          state.roster.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
        } else {
          if (!cur) return { ok: false, error: '명단에 없는 학생이에요' };
          cur.name = c.name;
          cur.night = c.night;
        }
        state.rosterTag = 'custom';
        syncSeats(state);
        return { ok: true, student: c };
      }
      case 'night-set': {
        const ids = new Set((action.ids || []).map(String));
        let count = 0;
        state.roster.forEach((s) => { if (ids.has(s.id) && s.night !== !!action.night) { s.night = !!action.night; count += 1; } });
        state.rosterTag = 'custom';
        return { ok: true, count };
      }
      case 'student-delete': {
        const ids = new Set((action.ids || []).map(String));
        if (!ids.size) return { ok: false, error: '지울 학생을 골라 주세요' };
        const before = state.roster.length;
        state.roster = state.roster.filter((s) => !ids.has(s.id));
        state.rosterTag = 'custom';
        syncSeats(state);
        return { ok: true, count: before - state.roster.length };
      }
      default:
        return { ok: false, error: '알 수 없는 요청이에요' };
    }
  }

  /* 하루 출석 요약: 학생마다 처음 들어온 시각, 마지막 자리, 나간 시각, 조퇴 여부 */
  function dayRecord(state) {
    const students = {};
    state.log.slice().reverse().forEach((l) => {
      const r = students[l.id] || (students[l.id] = { name: l.name, in: l.at, seat: l.seat, left: null, early: false, outs: 0 });
      r.name = l.name;
      if (l.type === 'assign' || l.type === 'move') { r.seat = l.seat; r.left = null; r.early = false; }
      if (l.type === 'release') { r.left = l.at; r.early = l.note === 'early'; }
      if (l.type === 'out') r.outs += 1;
    });
    return {
      day: state.day,
      night: state.roster.filter((s) => s.night !== false).map((s) => s.id),
      names: Object.fromEntries(state.roster.filter((s) => s.night !== false || students[s.id]).map((s) => [s.id, s.name])),
      students,
      log: state.log
    };
  }

  /* CSV 한 덩어리를 줄과 칸으로 나눈다 (따옴표 안의 쉼표, 줄바꿈 처리) */
  function parseCsv(text) {
    text = String(text || '').replace(/^﻿/, '');
    const delim = (text.split(/\r?\n/, 1)[0].match(/\t/g) || []).length > (text.split(/\r?\n/, 1)[0].match(/,/g) || []).length ? '\t' : ',';
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    /* 빈 줄도 남겨 둬야 문제 줄 번호가 엑셀에서 보는 줄 번호와 맞는다 */
    return rows.map((r) => r.map((c) => String(c).trim()));
  }

  /*
   표(줄과 칸)에서 명단을 뽑는다. 머리글이 있으면 칸 이름으로 찾고, 없으면 첫 칸 학번, 둘째 칸 이름으로 본다.
   학번 칸이 없고 학년, 반, 번호 칸이 따로 있으면 학년 1자리 + 반 2자리 + 번호 2자리로 학번을 만든다.
   돌려주는 값: { rows: [{id, name, night, line}], problems: [{line, text}], hasName, hasNight }
  */
  function rosterFromTable(table) {
    const norm = (s) => String(s || '').replace(/\s/g, '');
    let head = -1, col = {};
    for (let i = 0; i < Math.min(table.length, 15); i++) {
      const c = {};
      table[i].forEach((v, j) => {
        const t = norm(v);
        if (c.id === undefined && /^학번$|학번|^ID$/i.test(t)) c.id = j;
        else if (c.name === undefined && /^(이름|성명|학생명|학생이름|name)$/i.test(t)) c.name = j;
        else if (c.grade === undefined && /^학년$/.test(t)) c.grade = j;
        else if (c.cls === undefined && /^(반|학급)$/.test(t)) c.cls = j;
        else if (c.no === undefined && /^(번호|번|출석번호)$/.test(t)) c.no = j;
        else if (c.night === undefined && /야자|신청|야간/.test(t)) c.night = j;
      });
      if ((c.id !== undefined || (c.grade !== undefined && c.cls !== undefined && c.no !== undefined)) && (c.name !== undefined || c.id !== undefined)) { head = i; col = c; break; }
    }
    let hasName = col.name !== undefined, hasNight = col.night !== undefined;
    if (head === -1) {
      col = { id: 0, name: 1, night: 2 };
      hasName = table.some((r) => /^\d+$/.test(norm(r[0])) && norm(r[1]) !== '');
      hasNight = table.some((r) => /^\d+$/.test(norm(r[0])) && norm(r[2]) !== '');
    }
    const yes = (v) => { const t = norm(v).toLowerCase(); return !(t === '0' || t === 'x' || t === 'n' || t === 'no' || t === '아니오' || t === '아니요' || t === '안함' || t === '미신청' || t === 'false'); };
    const rows = [], problems = [];
    for (let i = head + 1; i < table.length; i++) {
      const r = table[i];
      const line = i + 1;
      let id = col.id !== undefined ? norm(r[col.id]) : '';
      if (!id && col.grade !== undefined) {
        const g = norm(r[col.grade]).replace(/학년$/, ''), c = norm(r[col.cls]).replace(/반$/, ''), n = norm(r[col.no]).replace(/번$/, '');
        if (/^\d$/.test(g) && /^\d{1,2}$/.test(c) && /^\d{1,2}$/.test(n)) id = g + c.padStart(2, '0') + n.padStart(2, '0');
      }
      id = id.replace(/\.0$/, '');
      const name = hasName ? String(r[col.name] || '').trim() : '';
      if (!id && !name) continue;
      /* 머리글이 없는 파일의 제목 줄 같은 것은 조용히 건너뛴다 */
      if (head === -1 && !/^\d+$/.test(id)) { if (rows.length) problems.push({ line, text: '학번이 숫자가 아니에요' }); continue; }
      if (!id && col.grade !== undefined) { problems.push({ line, text: (name || '이름 없음') + ': 학년, 반, 번호를 확인해 주세요' }); continue; }
      if (!/^\d{4,12}$/.test(id)) { problems.push({ line, text: (id || '빈칸') + ': 학번은 숫자 4~12자리여야 해요' }); continue; }
      if (hasName && !name) { problems.push({ line, text: id + ': 이름이 비어 있어요' }); continue; }
      if (name.length > 30) { problems.push({ line, text: id + ': 이름이 너무 길어요' }); continue; }
      const night = hasNight && r[col.night] !== undefined && norm(r[col.night]) !== '' ? yes(r[col.night]) : true;
      rows.push({ id, name, night, line });
    }
    /* 같은 학번이 여러 번 나오면 뒤의 것을 문제로 표시한다 */
    const seen = new Map();
    const out = [];
    rows.forEach((s) => {
      if (seen.has(s.id)) { problems.push({ line: s.line, text: s.id + ': ' + seen.get(s.id) + '번째 줄과 학번이 같아요' }); return; }
      seen.set(s.id, s.line);
      out.push(s);
    });
    problems.sort((a, b) => a.line - b.line);
    return { rows: out, problems, hasName, hasNight };
  }

  /* CSV: 학번,이름,야자(1/0) — 첫 줄이 머리글이면 건너뛴다 */
  function parseRosterCsv(text) {
    return rosterFromTable(parseCsv(text)).rows.filter((s) => s.name).map((s) => ({ id: s.id, name: s.name, night: s.night }));
  }

  return {
    ADMIN_TYPES, todayKey, hhmm, defaultSettings, emptyState, rosterTag, syncDefaultRoster, allSeatNumbers, findStudent, seatOf,
    isClosed, isNightDay, isNightTime, kioskOpen, rollDay, apply, checkStudent, checkRoster, dayRecord, parseCsv, rosterFromTable, parseRosterCsv, message
  };
});
