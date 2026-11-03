/* 저장소: 서버(api/)가 있으면 서버 모드, 없으면 브라우저 저장소 모드 */
(function () {
  'use strict';
  const Core = window.KioskCore;
  const KEY = 'study-room-kiosk/state/v2';

  async function getJson(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  }

  function createLocal(layout, defaultRoster) {
    let state;
    try { state = JSON.parse(localStorage.getItem(KEY)); } catch (e) { state = null; }
    if (!state || state.version !== 1) state = Core.emptyState(defaultRoster);
    state.settings = Object.assign(Core.defaultSettings(), state.settings);
    Core.syncDefaultRoster(state, defaultRoster);
    const subs = new Set();
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} };
    if (Core.rollDay(state)) save();
    save();

    window.addEventListener('storage', (e) => {
      if (e.key !== KEY || !e.newValue) return;
      try { state = JSON.parse(e.newValue); subs.forEach((f) => f(state)); } catch (err) {}
    });

    return {
      mode: 'local',
      layout,
      get state() { return state; },
      subscribe(f) { subs.add(f); return () => subs.delete(f); },
      async dispatch(action) {
        if (Core.ADMIN_TYPES.has(action.type) || action.byTeacher) {
          if (action.pin !== state.settings.pin) return { ok: false, error: '다시 로그인해 주세요', auth: true };
        }
        let res;
        if (action.type === 'change-pin') {
          if (action.current !== state.settings.pin) return { ok: false, error: '지금 PIN이 맞지 않아요' };
          if (!/^\d{4,8}$/.test(String(action.next || ''))) return { ok: false, error: 'PIN은 숫자 4~8자리로 정해 주세요' };
          state.settings.pin = String(action.next);
          res = { ok: true };
        } else res = Core.apply(state, layout, action);
        if (res.ok) {
          save();
          subs.forEach((f) => f(state));
          if ((action.type === 'assign') && !res.unchanged && state.settings.webhookUrl) {
            const ev = state.events[state.events.length - 1];
            try {
              fetch(state.settings.webhookUrl, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(ev) });
            } catch (e) {}
          }
        }
        return res;
      },
      async refresh() { return state; }
    };
  }

  function createRemote(layout, initial) {
    let state = initial;
    const subs = new Set();
    const set = (s) => { state = s; subs.forEach((f) => f(state)); };
    let last = '';
    /* 서버가 ETag로 304를 주면 브라우저가 저장본을 돌려준다. 내용이 같으면 다시 그리지 않는다 */
    async function refresh() {
      try {
        const r = await fetch('api/state', { cache: 'no-cache' });
        if (r.ok) {
          const text = await r.text();
          if (text !== last) { last = text; set(JSON.parse(text)); }
        }
      } catch (e) {}
      return state;
    }
    setInterval(refresh, 3000);
    return {
      mode: 'server',
      layout,
      get state() { return state; },
      subscribe(f) { subs.add(f); return () => subs.delete(f); },
      async dispatch(action) {
        try {
          const r = await fetch('api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
          const j = await r.json();
          if (j.state) set(j.state);
          return j.result || { ok: false, error: '서버 응답이 이상해요' };
        } catch (e) {
          return { ok: false, error: '서버에 연결하지 못했어요' };
        }
      },
      refresh
    };
  }

  async function open() {
    const layout = await getJson('data/layout.json');
    try {
      const s = await getJson('api/state');
      if (s && s.version === 1) return createRemote(layout, s);
    } catch (e) {}
    const roster = await getJson('data/roster.json');
    return createLocal(layout, roster);
  }

  window.KioskStore = { open };
})();
