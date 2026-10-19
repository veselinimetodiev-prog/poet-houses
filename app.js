/* Poets' Houses of Bulgaria – a GeoGuessr-style game.
   The browser only shows things. The database functions keep the answers and calculate all scores. */
(function () {
  'use strict';

  const CFG = window.GAME_CONFIG || {};
  const TEXT = window.I18N;
  const BG_BOUNDS = L.latLngBounds([41.2, 22.3], [44.25, 28.65]);
  const ROUND_MAX = 5000;
  const app = document.getElementById('app');

  let lang = safeGet('lang') || 'bg';
  let sb = null;
  let me = null;
  let cleanupFns = [];
  let lastChallenge = null;

  // ---------------------------------------------------------------- helpers
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function sessGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function sessSet(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }

  function t(key, vars) {
    let s = (TEXT[lang] && TEXT[lang][key]) || TEXT.bg[key] || key;
    if (vars) Object.keys(vars).forEach(k => { s = s.split('{' + k + '}').join(vars[k]); });
    return s;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function pick(obj, base) { return obj[base + '_' + lang] || obj[base + '_bg'] || ''; }
  function fmtInt(n) { return Number(n || 0).toLocaleString(lang === 'bg' ? 'bg-BG' : 'en-GB'); }
  function fmtDist(km) {
    if (km == null) return t('no_guess');
    if (km < 1) return t('m_away', { d: Math.round(km * 1000) });
    return t('km_away', { d: km < 10 ? km.toFixed(1) : fmtInt(Math.round(km)) });
  }
  function fmtDate(s) { return s ? new Date(s).toLocaleString(lang === 'bg' ? 'bg-BG' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }) : ''; }
  function settingsText(c) {
    return t('class_settings', {
      r: c.rounds,
      t: c.timer_seconds > 0 ? t('timer_s', { s: c.timer_seconds }) : t('no_timer'),
      m: c.no_move ? t('no_move_on') : t('move_on')
    });
  }

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function errText(e) {
    const m = (e && (e.code || e.message || e.error || String(e))) || '';
    const codes = ['BAD_NICKNAME', 'BAD_PIN', 'NICK_TAKEN', 'BAD_LOGIN', 'LOCKED', 'BAD_CODE', 'NOT_MEMBER', 'ALREADY_PLAYED', 'RATE'];
    for (const c of codes) if (m.indexOf(c) !== -1) return t('err_' + c);
    if (e && (e.status === 429 || /rate limit/i.test(m))) return t('err_RATE');
    console.error(e);
    return t('err_generic');
  }

  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args || {});
    if (error) throw error;
    if (data && data.error) { const err = new Error(data.error); err.data = data; throw err; }
    return data;
  }

  async function ensureAuth() {
    const { data } = await sb.auth.getSession();
    if (data.session) return;
    const { error } = await sb.auth.signInAnonymously();
    if (error) { error.code = error.status === 429 ? 'RATE' : error.code; throw error; }
  }

  function baseUrl() { return location.origin + location.pathname; }
  async function share(url) {
    if (navigator.share) { try { await navigator.share({ title: t('title'), url }); return; } catch (e) { /* cancelled */ } }
    try { await navigator.clipboard.writeText(url); toast(t('copied')); } catch (e) { prompt(t('share_link'), url); }
  }

  function cleanup() { cleanupFns.forEach(fn => { try { fn(); } catch (e) { /* already gone */ } }); cleanupFns = []; }
  function view(html) { cleanup(); app.innerHTML = html; window.scrollTo(0, 0); applyStatic(); }
  function applyStatic() {
    document.documentElement.lang = lang;
    document.title = t('title');
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.getElementById('langBtn').textContent = t('lang_other');
    document.getElementById('signOutBtn').hidden = !me;
  }
  function $(sel) { return app.querySelector(sel); }
  function $all(sel) { return Array.from(app.querySelectorAll(sel)); }

  function tileLayer() {
    return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    });
  }
  function pinIcon(kind) { return L.divIcon({ className: kind === 'true' ? 'pin-true' : 'pin-guess', iconSize: [20, 20], iconAnchor: [10, 10] }); }
  function makeMap(el, opts) {
    const map = L.map(el, Object.assign({ maxBounds: BG_BOUNDS.pad(0.25), maxBoundsViscosity: 1, minZoom: 6, worldCopyJump: false }, opts || {}));
    tileLayer().addTo(map);
    map.fitBounds(BG_BOUNDS);
    cleanupFns.push(() => map.remove());
    return map;
  }

  // ---------------------------------------------------------------- start
  async function init() {
    applyStatic();
    document.getElementById('langBtn').onclick = () => { lang = lang === 'bg' ? 'en' : 'bg'; safeSet('lang', lang); rerender(); };
    document.getElementById('brand').onclick = () => { if (me) renderHome(); };
    document.getElementById('signOutBtn').onclick = signOut;

    if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.indexOf('PASTE_') === 0 || !window.supabase) {
      view('<div class="page"><div class="card"><h2>⚙️</h2><p>' + esc(t('setup_missing')) + '</p></div></div>');
      return;
    }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

    const params = new URLSearchParams(location.search);
    if (params.get('challenge')) sessSet('pendingChallenge', params.get('challenge').toUpperCase());
    if (params.get('class')) sessSet('pendingClass', params.get('class').toUpperCase());
    if (params.get('challenge') || params.get('class')) history.replaceState(null, '', baseUrl());

    try {
      const { data } = await sb.auth.getSession();
      if (data.session) me = await rpc('me');
    } catch (e) { me = null; }
    route();
  }

  let rerender = () => route();
  async function route() {
    if (!me) { renderLogin(); return; }
    const pc = sessGet('pendingClass');
    if (pc) {
      sessSet('pendingClass', null);
      try { const c = await rpc('join_class', { p_code: pc }); toast(t('joined', { name: c.name })); me = await rpc('me'); }
      catch (e) { toast(errText(e)); }
    }
    const ch = sessGet('pendingChallenge');
    if (ch) { sessSet('pendingChallenge', null); startGame({ challenge: ch }); return; }
    renderHome();
  }

  async function signOut() {
    try { await rpc('logout_player'); } catch (e) { /* already signed out */ }
    await sb.auth.signOut();
    me = null; safeSet('currentGame', null);
    renderLogin();
  }

  // ---------------------------------------------------------------- login
  function renderLogin(mode) {
    rerender = () => renderLogin(mode);
    mode = mode || 'new';
    view(`
      <div class="page">
        <div class="hero">
          <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 30 32 10l24 20v24H8z" fill="currentColor"/><rect x="26" y="38" width="12" height="16" fill="var(--bg)"/></svg>
          <h1>${esc(t('title'))}</h1>
          <p class="muted">${esc(t('subtitle'))}</p>
        </div>
        <div class="card">
          <div class="tabs">
            <button class="tab ${mode === 'new' ? 'active' : ''}" data-mode="new">${esc(t('new_player'))}</button>
            <button class="tab ${mode === 'login' ? 'active' : ''}" data-mode="login">${esc(t('have_account'))}</button>
          </div>
          <form id="loginForm" autocomplete="off">
            <label for="nick">${esc(t('nickname'))}</label>
            <input id="nick" type="text" maxlength="20" required autocapitalize="off" spellcheck="false">
            <label for="pin">${esc(t('pin'))}</label>
            <input id="pin" type="password" inputmode="numeric" pattern="[0-9]*" minlength="4" maxlength="8" required>
            ${mode === 'new' ? `<p class="small muted">${esc(t('pin_hint'))}</p>` : ''}
            <p class="error" id="loginErr"></p>
            <button class="btn primary big" type="submit">${esc(mode === 'new' ? t('create_player') : t('sign_in'))}</button>
          </form>
          ${CFG.ENABLE_GOOGLE_LOGIN ? `
            <p class="center muted" style="margin:14px 0 8px">${esc(t('or'))}</p>
            <button class="btn big" id="googleBtn" type="button">${esc(t('google'))}</button>
            <p class="small muted">${esc(t('google_note'))}</p>` : ''}
        </div>
      </div>`);
    $all('.tab').forEach(b => b.onclick = () => renderLogin(b.dataset.mode));
    $('#loginForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const btn = ev.submitter || $('#loginForm button'); btn.disabled = true;
      $('#loginErr').textContent = '';
      try {
        await ensureAuth();
        const res = await rpc(mode === 'new' ? 'register_player' : 'login_player', { p_nickname: $('#nick').value, p_pin: $('#pin').value });
        me = res.player;
        route();
      } catch (e) { $('#loginErr').textContent = errText(e); btn.disabled = false; }
    };
    const g = $('#googleBtn');
    if (g) g.onclick = async () => {
      const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: baseUrl() } });
      if (error) $('#loginErr').textContent = errText(error);
    };
  }

  // ---------------------------------------------------------------- home
  function renderHome() {
    rerender = renderHome;
    const classes = (me.classes || []);
    const current = safeGet('currentGame');
    view(`
      <div class="page">
        <h1>${esc(t('hello', { name: me.nickname }))}</h1>
        ${current ? `<div class="card"><button class="btn primary big" id="continueBtn">▶ ${esc(t('next'))}</button></div>` : ''}
        <div class="card">
          <button class="btn primary big" id="freeBtn">${esc(t('play_free'))}</button>
          <p class="small muted center" style="margin-top:6px">${esc(t('play_free_desc', { n: CFG.FREE_PLAY_ROUNDS || 5 }))}</p>
        </div>
        ${classes.length ? `<div class="card"><h2>${esc(t('my_classes'))}</h2>
          ${classes.map(c => `<div class="row house-row">
              <div><b>${esc(c.name)}</b><div class="small muted">${esc(settingsText(c))}</div></div>
              <button class="btn primary" style="flex:0 0 auto" data-class="${esc(c.id)}">${esc(t('play_class'))}</button>
            </div>`).join('')}</div>` : ''}
        <div class="card grid2">
          <form id="joinForm">
            <h3>${esc(t('join_class'))}</h3>
            <input id="joinCode" type="text" placeholder="${esc(t('class_code'))}" maxlength="6" autocapitalize="characters" required>
            <button class="btn" style="width:100%;margin-top:8px" type="submit">${esc(t('join'))}</button>
          </form>
          <form id="chForm">
            <h3>${esc(t('challenge'))}</h3>
            <input id="chCode" type="text" placeholder="${esc(t('challenge_code'))}" maxlength="6" autocapitalize="characters" required>
            <button class="btn" style="width:100%;margin-top:8px" type="submit">${esc(t('play'))}</button>
          </form>
        </div>
        <details class="card">
          <summary><b>${esc(t('create_challenge'))}</b></summary>
          <p class="small muted">${esc(t('challenge_desc'))}</p>
          ${challengeForm()}
        </details>
        <div class="row">
          <button class="btn" id="lbBtn">🏆 ${esc(t('leaderboard'))}</button>
          ${me.is_teacher ? `<button class="btn" id="teacherBtn">🎓 ${esc(t('teacher'))}</button>` : ''}
        </div>
      </div>`);
    $('#freeBtn').onclick = () => startGame({ rounds: CFG.FREE_PLAY_ROUNDS || 5, timer: 0, noMove: false });
    if (current) $('#continueBtn').onclick = () => playRound({ id: current });
    $all('[data-class]').forEach(b => b.onclick = () => startGame({ classId: b.dataset.class }));
    $('#joinForm').onsubmit = async (ev) => {
      ev.preventDefault();
      try { const c = await rpc('join_class', { p_code: $('#joinCode').value }); toast(t('joined', { name: c.name })); me = await rpc('me'); renderHome(); }
      catch (e) { toast(errText(e)); }
    };
    $('#chForm').onsubmit = (ev) => { ev.preventDefault(); startGame({ challenge: $('#chCode').value.toUpperCase().trim() }); };
    bindChallengeForm();
    $('#lbBtn').onclick = () => renderLeaderboard();
    if (me.is_teacher) $('#teacherBtn').onclick = renderTeacher;
  }

  function challengeForm() {
    return `<form class="chCreate">
      <div class="grid2">
        <div><label>${esc(t('rounds'))}</label><input name="rounds" type="number" min="1" max="10" value="5"></div>
        <div><label>${esc(t('timer'))}</label><input name="timer" type="number" min="0" max="600" step="5" value="0"></div>
      </div>
      <label class="check"><input name="nomove" type="checkbox"> ${esc(t('no_move'))}</label>
      <button class="btn primary" type="submit">${esc(t('create'))}</button>
      <div class="chResult"></div>
    </form>`;
  }
  function bindChallengeForm() {
    $all('.chCreate').forEach(f => f.onsubmit = async (ev) => {
      ev.preventDefault();
      try {
        const c = await rpc('create_challenge', { p_rounds: +f.rounds.value, p_timer: +f.timer.value, p_no_move: f.nomove.checked });
        const url = baseUrl() + '?challenge=' + c.code;
        f.querySelector('.chResult').innerHTML = `<p style="margin-top:10px"><b>${esc(t('t_code'))}: ${esc(c.code)}</b><br><span class="small">${esc(url)}</span></p>
          <div class="row"><button type="button" class="btn small shareBtn">${esc(t('share_link'))}</button>
          <button type="button" class="btn small primary playBtn">${esc(t('play'))}</button></div>`;
        f.querySelector('.shareBtn').onclick = () => share(url);
        f.querySelector('.playBtn').onclick = () => startGame({ challenge: c.code });
      } catch (e) { toast(errText(e)); }
    });
  }

  // ---------------------------------------------------------------- game
  async function startGame(opts) {
    view(`<p class="center muted" style="padding:40px">${esc(t('loading'))}</p>`);
    try {
      const g = await rpc('start_game', {
        p_class_id: opts.classId || null, p_challenge: opts.challenge || null,
        p_rounds: opts.rounds || 5, p_timer: opts.timer || 0, p_no_move: !!opts.noMove
      });
      if (opts.challenge) lastChallenge = opts.challenge;
      safeSet('currentGame', g.game_id);
      playRound({ id: g.game_id, opts });
    } catch (e) {
      if (e.data && e.data.error === 'ALREADY_PLAYED') { toast(t('err_ALREADY_PLAYED')); lastChallenge = opts.challenge; renderResults(e.data.game_id); return; }
      toast(errText(e)); renderHome();
    }
  }

  async function playRound(game) {
    let r;
    try { r = await rpc('get_round', { p_game_id: game.id }); }
    catch (e) { safeSet('currentGame', null); toast(errText(e)); renderHome(); return; }
    if (r.finished) { safeSet('currentGame', null); renderResults(game.id); return; }
    rerender = () => playRound(game);

    view(`
      <div class="game">
        <div class="pano" id="pano"></div>
        <div class="hud">
          <span class="pill">${esc(t('round_x', { r: r.round, n: r.rounds }))}</span>
          <span class="pill" id="timerPill" ${r.timer_seconds > 0 ? '' : 'hidden'}></span>
          <span class="pill">${fmtInt(r.total)} ${esc(t('points'))}</span>
        </div>
        <div class="guess-box" id="guessBox">
          <div class="sheet-head"><b>${esc(t('place_pin'))}</b><button class="btn small" id="closeSheet">✕</button></div>
          <div class="guess-map" id="guessMap"></div>
          <button class="btn primary" id="guessBtn" disabled>${esc(t('place_pin'))}</button>
        </div>
        <div class="map-toggle"><button class="btn primary" id="openSheet">🗺 ${esc(t('map'))}</button></div>
      </div>`);

    setupLocationView(r);

    const box = $('#guessBox');
    const map = makeMap($('#guessMap'), { zoomControl: true });
    let marker = null;
    map.on('click', (e) => {
      if (!marker) marker = L.marker(e.latlng, { icon: pinIcon('guess'), draggable: true }).addTo(map);
      else marker.setLatLng(e.latlng);
      const b = $('#guessBtn'); b.disabled = false; b.textContent = t('guess');
    });
    // The map box changes size. Fit Bulgaria again until the player puts a pin.
    const refit = () => { map.invalidateSize(); if (!marker) map.fitBounds(BG_BOUNDS); };
    const resize = () => setTimeout(refit, 280);
    box.addEventListener('mouseenter', resize);
    box.addEventListener('transitionend', (e) => { if (e.target === box) refit(); });
    $('#openSheet').onclick = () => { box.classList.add('open'); resize(); };
    $('#closeSheet').onclick = () => box.classList.remove('open');

    let sent = false;
    const send = async () => {
      if (sent) return; sent = true;
      $('#guessBtn').disabled = true;
      const ll = marker ? marker.getLatLng() : null;
      try {
        const res = await rpc('submit_guess', { p_game_id: game.id, p_lat: ll ? ll.lat : null, p_lon: ll ? ll.lng : null });
        if (res.finished) safeSet('currentGame', null);
        renderReveal(game, res);
      } catch (e) { sent = false; $('#guessBtn').disabled = false; toast(errText(e)); }
    };
    $('#guessBtn').onclick = send;

    if (r.timer_seconds > 0) {
      const endAt = Date.now() + (r.seconds_left || 0) * 1000;
      const pill = $('#timerPill');
      const tick = () => {
        const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
        pill.textContent = '⏱ ' + left + 's';
        pill.classList.toggle('warn', left <= 10);
        if (left <= 0) { clearInterval(id); toast(t('time_up')); send(); }
      };
      const id = setInterval(tick, 250); tick();
      cleanupFns.push(() => clearInterval(id));
    }
  }

  function clueCards(r) {
    return `<div class="clue"><b>${esc(t('poet'))}</b>${esc(pick(r, 'poet'))}</div>
            <div class="clue"><b>${esc(t('clue'))}</b>${esc(pick(r, 'clues'))}</div>`;
  }

  function showPhoto(r, note) {
    const pano = $('#pano');
    if (!pano) return;
    pano.innerHTML = `<div class="photo-view">
        ${r.photo_url ? `<img id="housePhoto" src="${esc(r.photo_url)}" alt="" referrerpolicy="no-referrer">` : ''}
        <div class="clues">
          <p class="small muted">${esc(note || '')}</p>
          ${clueCards(r)}
        </div></div>`;
    const img = pano.querySelector('#housePhoto');
    if (img) img.onerror = () => { img.remove(); pano.querySelector('.clues p').textContent = t('photo_missing'); };
    if (!r.photo_url) pano.querySelector('.clues p').textContent = t('photo_missing');
  }

  function setupLocationView(r) {
    const canStreet = r.mapillary_id && CFG.MAPILLARY_TOKEN && window.mapillary;
    if (!canStreet) { showPhoto(r, t('no_street_view')); return; }

    const nm = !!r.no_move;
    let viewer;
    try {
      viewer = new mapillary.Viewer({
        accessToken: CFG.MAPILLARY_TOKEN,
        container: 'pano',
        component: {
          cover: false,
          direction: !nm,
          sequence: !nm,
          zoom: !nm,
          keyboard: nm ? false : true,
          pointer: nm ? { dragPan: true, scrollZoom: false, touchZoom: false, earthControl: false } : true
        }
      });
    } catch (e) { showPhoto(r, t('no_street_view')); return; }
    cleanupFns.push(() => viewer.remove());
    viewer.moveTo(r.mapillary_id).catch(() => { try { viewer.remove(); } catch (e) { /* gone */ } showPhoto(r, t('no_street_view')); });
    if (nm) viewer.on('image', (ev) => { if (ev.image && ev.image.id !== r.mapillary_id) viewer.moveTo(r.mapillary_id).catch(() => {}); });

    const hint = document.createElement('div');
    hint.className = 'hint-panel';
    hint.innerHTML = `<button class="btn small" type="button">💡 ${esc(t('hint'))}</button><div hidden style="margin-top:8px">${clueCards(r)}</div>`;
    hint.querySelector('button').onclick = () => { const d = hint.querySelector('div'); d.hidden = !d.hidden; };
    document.querySelector('.game').appendChild(hint);
  }

  // ---------------------------------------------------------------- reveal
  function renderReveal(game, res) {
    rerender = () => renderReveal(game, res);
    const h = res.house;
    const pct = Math.round(res.score / ROUND_MAX * 100);
    view(`
      <div class="reveal">
        <div class="reveal-map" id="revealMap"></div>
        <div class="reveal-card">
          <div class="row" style="justify-content:space-between">
            <div class="big-score" style="flex:0 0 auto">+${fmtInt(res.score)}</div>
            <div class="muted small" style="text-align:right">${esc(t('round_x', { r: res.round, n: res.rounds }))}<br>${esc(t('t_total'))}: <b>${fmtInt(res.total)}</b></div>
          </div>
          <div class="bar"><i id="scoreBar"></i></div>
          <p><b>${esc(res.timed_out ? t('late') : fmtDist(res.distance_km))}</b></p>
          <h2>${esc(pick(h, 'name'))}</h2>
          <p class="muted small">${esc(h.address_bg)}</p>
          <div class="fact">${esc(pick(h, 'fact'))}</div>
          ${h.photo_url ? `<img src="${esc(h.photo_url)}" alt="" referrerpolicy="no-referrer" style="width:100%;border-radius:10px;max-height:220px;object-fit:cover" onerror="this.remove()">` : ''}
          ${h.photo_credit ? `<p class="credit">${esc(t('photo_credit'))}: ${esc(h.photo_credit)}</p>` : ''}
          <button class="btn primary big" id="nextBtn" style="margin-top:10px">${esc(res.finished ? t('see_results') : t('next'))}</button>
        </div>
      </div>`);
    requestAnimationFrame(() => { const b = $('#scoreBar'); if (b) b.style.width = pct + '%'; });
    const map = makeMap($('#revealMap'));
    const truth = L.latLng(h.lat, h.lon);
    L.marker(truth, { icon: pinIcon('true') }).addTo(map).bindTooltip(pick(h, 'poet'), { permanent: true, direction: 'top', offset: [0, -10] });
    if (res.guess_lat != null) {
      const g = L.latLng(res.guess_lat, res.guess_lon);
      L.marker(g, { icon: pinIcon('guess') }).addTo(map);
      L.polyline([g, truth], { color: '#c8553d', weight: 3, dashArray: '6 8' }).addTo(map);
      map.fitBounds(L.latLngBounds([g, truth]).pad(0.3), { maxZoom: 15 });
    } else {
      map.setView(truth, 9);
    }
    $('#nextBtn').onclick = () => res.finished ? renderResults(game.id) : playRound(game);
  }

  // ---------------------------------------------------------------- results
  async function renderResults(gameId, fromTeacher) {
    let r;
    try { r = await rpc('get_results', { p_game_id: gameId }); } catch (e) { toast(errText(e)); renderHome(); return; }
    rerender = () => renderResults(gameId, fromTeacher);
    const max = r.rounds * ROUND_MAX;
    const ch = r.challenge_code;
    view(`
      <div class="page">
        <div class="card center">
          <p class="muted">${esc(t('final_score'))}${fromTeacher ? ' – ' + esc(r.nickname) : ''}</p>
          <div class="big-score" style="font-size:3rem">${fmtInt(r.total)}</div>
          <p class="muted">${esc(t('out_of', { max: fmtInt(max) }))}</p>
          <div class="bar"><i id="scoreBar"></i></div>
        </div>
        <div class="results-map" id="resMap"></div>
        <div class="card table-wrap">
          <table>
            <thead><tr><th>${esc(t('round'))}</th><th>${esc(t('house'))}</th><th class="num">${esc(t('distance'))}</th><th class="num">${esc(t('score'))}</th></tr></thead>
            <tbody>${(r.items || []).map(i => `<tr>
              <td>${i.round}</td><td>${esc(pick(i, 'name'))}</td>
              <td class="num">${i.timed_out ? '⏱' : (i.distance_km == null ? '—' : (i.distance_km < 1 ? Math.round(i.distance_km * 1000) + ' m' : (Math.round(i.distance_km * 10) / 10) + ' km'))}</td>
              <td class="num"><b>${fmtInt(i.score)}</b></td></tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="row">
          ${fromTeacher ? `<button class="btn" id="backBtn">${esc(t('back'))}</button>` : `
            ${ch ? `<button class="btn primary" id="shareCh">${esc(t('share_link'))}</button>` : `<button class="btn primary" id="againBtn">${esc(t('play_again'))}</button>`}
            <button class="btn" id="lbBtn">🏆 ${esc(t('leaderboard'))}</button>
            <button class="btn" id="homeBtn">${esc(t('home'))}</button>`}
        </div>
      </div>`);
    requestAnimationFrame(() => { const b = $('#scoreBar'); if (b) b.style.width = Math.round(r.total / max * 100) + '%'; });
    const map = makeMap($('#resMap'));
    const pts = [];
    (r.items || []).forEach(i => {
      const tr = L.latLng(i.lat, i.lon); pts.push(tr);
      L.marker(tr, { icon: pinIcon('true') }).addTo(map).bindTooltip(String(i.round), { permanent: true, direction: 'top', offset: [0, -10] });
      if (i.guess_lat != null) {
        const g = L.latLng(i.guess_lat, i.guess_lon); pts.push(g);
        L.marker(g, { icon: pinIcon('guess') }).addTo(map);
        L.polyline([g, tr], { color: '#c8553d', weight: 2, dashArray: '5 7' }).addTo(map);
      }
    });
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2));

    if (fromTeacher) { $('#backBtn').onclick = fromTeacher; return; }
    if (ch) $('#shareCh').onclick = () => share(baseUrl() + '?challenge=' + ch);
    else $('#againBtn').onclick = () => startGame(r.class_id ? { classId: r.class_id } : { rounds: r.rounds });
    $('#lbBtn').onclick = () => renderLeaderboard(ch ? { scope: 'challenge', id: ch } : (r.class_id ? { scope: 'class', id: r.class_id } : null));
    $('#homeBtn').onclick = renderHome;
  }

  // ---------------------------------------------------------------- leaderboard
  function renderLeaderboard(sel) {
    sel = sel || { scope: 'global', id: null };
    rerender = () => renderLeaderboard(sel);
    const tabs = [{ scope: 'global', id: null, label: t('lb_global') }]
      .concat((me.classes || []).map(c => ({ scope: 'class', id: c.id, label: c.name })));
    const ch = sel.scope === 'challenge' ? sel.id : lastChallenge;
    if (ch) tabs.push({ scope: 'challenge', id: ch, label: t('challenge') + ' ' + ch });
    view(`
      <div class="page">
        <h1>🏆 ${esc(t('leaderboard'))}</h1>
        <div class="tabs">${tabs.map((tb, k) => `<button class="tab ${tb.scope === sel.scope && tb.id === sel.id ? 'active' : ''}" data-k="${k}">${esc(tb.label)}</button>`).join('')}</div>
        <div class="card table-wrap" id="lbBody"><p class="muted">${esc(t('loading'))}</p></div>
        <p class="small muted">● ${esc(t('lb_live'))}. ${sel.scope === 'challenge' ? '' : esc(t('lb_note'))}</p>
        <button class="btn" id="homeBtn">${esc(t('home'))}</button>
      </div>`);
    $all('.tab').forEach(b => b.onclick = () => renderLeaderboard(tabs[+b.dataset.k]));
    $('#homeBtn').onclick = renderHome;

    const load = async () => {
      try {
        const rows = await rpc('get_leaderboard', { p_scope: sel.scope, p_id: sel.id });
        const body = $('#lbBody'); if (!body) return;
        body.innerHTML = !rows.length ? `<p class="muted">${esc(t('lb_empty'))}</p>` : `<table>
          <thead><tr><th>#</th><th>${esc(t('nickname_col'))}</th><th class="num">${esc(t('best_col'))}</th><th class="num">${esc(t('games_col'))}</th></tr></thead>
          <tbody>${rows.map((x, i) => `<tr class="${x.is_me ? 'me' : ''}"><td>${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</td>
            <td>${esc(x.nickname)}</td><td class="num">${fmtInt(x.best)}</td><td class="num">${x.games}</td></tr>`).join('')}</tbody></table>`;
      } catch (e) { const body = $('#lbBody'); if (body) body.innerHTML = `<p class="error">${esc(errText(e))}</p>`; }
    };
    load();
    let debounce = null;
    const channel = sb.channel('scores-' + Math.random().toString(36).slice(2))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'score_events' }, () => { clearTimeout(debounce); debounce = setTimeout(load, 800); })
      .subscribe();
    // A slow refresh also runs, in case the live connection drops on a phone.
    const poll = setInterval(load, 30000);
    cleanupFns.push(() => { sb.removeChannel(channel); clearInterval(poll); clearTimeout(debounce); });
  }

  // ---------------------------------------------------------------- teacher
  async function renderTeacher() {
    rerender = renderTeacher;
    me = await rpc('me');
    const own = (me.classes || []).filter(c => c.is_owner);
    view(`
      <div class="page">
        <h1>🎓 ${esc(t('teacher'))}</h1>
        <div class="tabs">
          <button class="tab active" data-sec="classes">${esc(t('t_classes'))}</button>
          <button class="tab" data-sec="challenge">${esc(t('challenge'))}</button>
          <button class="tab" data-sec="houses">${esc(t('t_houses'))}</button>
          <button class="tab" data-sec="players">${esc(t('t_players'))}</button>
        </div>
        <section data-sec="classes">
          ${own.map(c => `
            <div class="card" data-cid="${esc(c.id)}">
              <div class="row" style="justify-content:space-between">
                <h2 style="flex:1 1 auto">${esc(c.name)}</h2>
                <span style="flex:0 0 auto;font-size:1.4rem;font-weight:800;letter-spacing:.1em">${esc(c.code)}</span>
              </div>
              <p class="small muted">${esc(t('t_join_link'))}: ${esc(baseUrl() + '?class=' + c.code)}</p>
              <form class="classForm">
                <div class="grid2">
                  <div><label>${esc(t('t_class_name'))}</label><input name="name" type="text" maxlength="60" value="${esc(c.name)}"></div>
                  <div class="grid2">
                    <div><label>${esc(t('rounds'))}</label><input name="rounds" type="number" min="1" max="10" value="${c.rounds}"></div>
                    <div><label>${esc(t('timer'))}</label><input name="timer" type="number" min="0" max="600" step="5" value="${c.timer_seconds}"></div>
                  </div>
                </div>
                <label class="check"><input name="nomove" type="checkbox" ${c.no_move ? 'checked' : ''}> ${esc(t('no_move'))}</label>
                <div class="row">
                  <button class="btn small primary" type="submit">${esc(t('t_save'))}</button>
                  <button class="btn small" type="button" data-act="share">${esc(t('share_link'))}</button>
                  <button class="btn small" type="button" data-act="results">${esc(t('t_results'))}</button>
                  <button class="btn small" type="button" data-act="lb">🏆</button>
                  <button class="btn small danger" type="button" data-act="reset">${esc(t('t_reset'))}</button>
                </div>
              </form>
            </div>`).join('')}
          <div class="card">
            <h2>${esc(t('t_new_class'))}</h2>
            <form id="newClass">
              <label>${esc(t('t_class_name'))}</label><input name="name" type="text" maxlength="60" required>
              <div class="grid2">
                <div><label>${esc(t('rounds'))}</label><input name="rounds" type="number" min="1" max="10" value="5"></div>
                <div><label>${esc(t('timer'))}</label><input name="timer" type="number" min="0" max="600" step="5" value="0"></div>
              </div>
              <label class="check"><input name="nomove" type="checkbox"> ${esc(t('no_move'))}</label>
              <button class="btn primary" type="submit">${esc(t('create'))}</button>
            </form>
          </div>
          <button class="btn danger" id="resetGlobal">${esc(t('t_reset_global'))}</button>
        </section>
        <section data-sec="challenge" hidden><div class="card"><p class="small muted">${esc(t('challenge_desc'))}</p>${challengeForm()}</div></section>
        <section data-sec="houses" hidden><div class="card" id="housesBox"><p class="muted">${esc(t('loading'))}</p></div></section>
        <section data-sec="players" hidden>
          <div class="card">
            <form id="pinForm" class="grid2">
              <div><label>${esc(t('nickname'))}</label><input name="nick" type="text" required></div>
              <div><label>${esc(t('pin'))}</label><input name="pin" type="text" inputmode="numeric" pattern="[0-9]{4,8}" required></div>
              <button class="btn primary" type="submit">${esc(t('t_reset_pin'))}</button>
              <button class="btn danger" type="button" id="delPlayer">${esc(t('t_delete_player'))}</button>
            </form>
          </div>
        </section>
      </div>`);

    $all('.tab').forEach(b => b.onclick = () => {
      $all('.tab').forEach(x => x.classList.toggle('active', x === b));
      $all('section').forEach(s => { s.hidden = s.dataset.sec !== b.dataset.sec; });
      if (b.dataset.sec === 'houses') renderHouses();
    });
    bindChallengeForm();

    $all('[data-cid]').forEach(card => {
      const cid = card.dataset.cid; const c = own.find(x => x.id === cid);
      const f = card.querySelector('.classForm');
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        try { await rpc('update_class', { p_class_id: cid, p_name: f.name.value, p_rounds: +f.rounds.value, p_timer: +f.timer.value, p_no_move: f.nomove.checked }); toast(t('t_saved')); renderTeacher(); }
        catch (e) { toast(errText(e)); }
      };
      card.querySelector('[data-act=share]').onclick = () => share(baseUrl() + '?class=' + c.code);
      card.querySelector('[data-act=results]').onclick = () => renderClassResults(c);
      card.querySelector('[data-act=lb]').onclick = () => renderLeaderboard({ scope: 'class', id: cid });
      card.querySelector('[data-act=reset]').onclick = async () => {
        if (!confirm(t('t_reset_confirm'))) return;
        try { await rpc('reset_class_leaderboard', { p_class_id: cid }); toast(t('t_done')); } catch (e) { toast(errText(e)); }
      };
    });
    $('#newClass').onsubmit = async (ev) => {
      ev.preventDefault(); const f = ev.target;
      try { await rpc('create_class', { p_name: f.name.value, p_rounds: +f.rounds.value, p_timer: +f.timer.value, p_no_move: f.nomove.checked }); renderTeacher(); }
      catch (e) { toast(errText(e)); }
    };
    $('#resetGlobal').onclick = async () => {
      if (!confirm(t('t_reset_confirm'))) return;
      try { await rpc('reset_global_leaderboard'); toast(t('t_done')); } catch (e) { toast(errText(e)); }
    };
    $('#pinForm').onsubmit = async (ev) => {
      ev.preventDefault(); const f = ev.target;
      try { const ok = await rpc('teacher_reset_pin', { p_nickname: f.nick.value, p_pin: f.pin.value }); toast(ok ? t('t_done') : t('t_not_found_player')); }
      catch (e) { toast(errText(e)); }
    };
    $('#delPlayer').onclick = async () => {
      const f = $('#pinForm'); if (!f.nick.value) return;
      if (!confirm(t('t_delete_confirm', { name: f.nick.value }))) return;
      try { const ok = await rpc('teacher_delete_player', { p_nickname: f.nick.value }); toast(ok ? t('t_done') : t('t_not_found_player')); }
      catch (e) { toast(errText(e)); }
    };
  }

  async function renderClassResults(c) {
    let r;
    try { r = await rpc('teacher_results', { p_class_id: c.id }); } catch (e) { toast(errText(e)); return; }
    rerender = () => renderClassResults(c);
    view(`
      <div class="page">
        <button class="btn small" id="backBtn">← ${esc(t('back'))}</button>
        <h1 style="margin-top:10px">${esc(c.name)} · ${esc(t('t_results'))}</h1>
        <div class="card"><h3>${esc(t('t_members'))} (${r.members.length})</h3>
          <p class="small">${r.members.map(m => esc(m.nickname)).join(', ') || '—'}</p></div>
        <div class="card table-wrap"><h3>${esc(t('t_games'))} (${r.games.length})</h3>
          <table><thead><tr><th>${esc(t('nickname_col'))}</th><th>${esc(t('t_date'))}</th><th>${esc(t('t_per_round'))}</th><th class="num">${esc(t('t_total'))}</th></tr></thead>
          <tbody>${r.games.map(g => `<tr ${g.finished_at ? `data-g="${esc(g.game_id)}" style="cursor:pointer"` : ''}>
            <td>${esc(g.nickname)}</td><td class="small">${esc(fmtDate(g.started_at))}</td>
            <td class="small">${(g.scores || []).map(fmtInt).join(' · ')}${g.finished_at ? '' : ' <i class="muted">(' + esc(t('t_unfinished')) + ')</i>'}</td>
            <td class="num"><b>${fmtInt(g.total)}</b></td></tr>`).join('')}</tbody></table>
        </div>
        <button class="btn" id="csvBtn">⬇ ${esc(t('t_csv'))}</button>
      </div>`);
    $('#backBtn').onclick = renderTeacher;
    $all('[data-g]').forEach(tr => tr.onclick = () => renderResults(tr.dataset.g, () => renderClassResults(c)));
    $('#csvBtn').onclick = () => {
      const n = Math.max(0, ...r.games.map(g => (g.scores || []).length));
      const head = ['nickname', 'started_at', 'finished_at', 'rounds', 'total'].concat(Array.from({ length: n }, (_, i) => 'round_' + (i + 1)));
      const lines = [head].concat(r.games.map(g => [g.nickname, g.started_at, g.finished_at || '', g.rounds, g.total].concat(g.scores || [])));
      const csv = '﻿' + lines.map(l => l.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = 'results-' + c.code + '.csv'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
  }

  // ----- houses: Mapillary coverage, photos and uploads
  function kmBetween(a, b, c, d) {
    const R = 6371, toR = Math.PI / 180;
    const x = Math.sin((c - a) * toR / 2) ** 2 + Math.cos(a * toR) * Math.cos(c * toR) * Math.sin((d - b) * toR / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  async function findMapillary(lat, lon) {
    for (const r of [0.0012, 0.004]) {
      const bbox = [lon - r * 1.35, lat - r, lon + r * 1.35, lat + r].map(v => v.toFixed(6)).join(',');
      const url = 'https://graph.mapillary.com/images?access_token=' + encodeURIComponent(CFG.MAPILLARY_TOKEN) +
        '&fields=id,computed_geometry,geometry,is_pano&limit=500&bbox=' + bbox;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('Mapillary ' + resp.status);
      const j = await resp.json();
      let best = null;
      (j.data || []).forEach(img => {
        const g = img.computed_geometry || img.geometry; if (!g) return;
        const d = kmBetween(lat, lon, g.coordinates[1], g.coordinates[0]) * 1000;
        const rank = d * (img.is_pano ? 0.6 : 1);
        if (!best || rank < best.rank) best = { id: img.id, d: Math.round(d), pano: !!img.is_pano, rank };
      });
      if (best) return best;
    }
    return null;
  }
  function randomName() { return Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join(''); }
  async function uploadBlob(blob) {
    const path = randomName() + '.jpg';
    const { error } = await sb.storage.from('house-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (error) throw error;
    return sb.storage.from('house-photos').getPublicUrl(path).data.publicUrl;
  }
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, 1600 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas'); cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        cv.toBlob(b => b ? resolve(b) : reject(new Error('image')), 'image/jpeg', 0.85);
        URL.revokeObjectURL(img.src);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  async function commonsToBlob(photoUrl) {
    const m = /Special:FilePath\/([^?#]+)/.exec(photoUrl || '');
    if (!m) return null;
    const title = 'File:' + decodeURIComponent(m[1]).replace(/_/g, ' ');
    const api = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&prop=imageinfo&iiprop=url&iiurlwidth=1280&titles=' + encodeURIComponent(title);
    const j = await (await fetch(api)).json();
    const page = Object.values(j.query.pages)[0];
    const info = page.imageinfo && page.imageinfo[0];
    if (!info) return null;
    const resp = await fetch(info.thumburl || info.url);
    if (!resp.ok) return null;
    return resp.blob();
  }

  async function renderHouses() {
    const box = $('#housesBox');
    let houses;
    try { houses = await rpc('teacher_houses'); } catch (e) { box.innerHTML = `<p class="error">${esc(errText(e))}</p>`; return; }
    const typeOf = h => h.mapillary_id ? 'street' : (h.photo_url ? 'photo' : 'clues');
    const typeLabel = { street: t('t_type_street'), photo: t('t_type_photo'), clues: t('t_type_clues') };
    box.innerHTML = `
      <p class="small muted">${esc(t('t_houses_desc'))}</p>
      <div class="row" style="margin-bottom:8px">
        <button class="btn small primary" id="mlyAll" ${CFG.MAPILLARY_TOKEN ? '' : 'disabled'}>${esc(t('t_check_mapillary'))}</button>
        <button class="btn small" id="copyAll" title="${esc(t('t_copy_commons_desc'))}">${esc(t('t_copy_commons'))}</button>
      </div>
      ${CFG.MAPILLARY_TOKEN ? '' : `<p class="small error">${esc(t('t_no_token'))}</p>`}
      <p class="small muted">${esc(t('t_copy_commons_desc'))}</p>
      ${houses.map(h => `
        <form class="house-row" data-h="${h.id}">
          <div class="row" style="align-items:flex-start">
            ${h.photo_url ? `<img class="thumb" style="flex:0 0 96px" src="${esc(h.photo_url)}" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : `<div class="thumb" style="flex:0 0 96px"></div>`}
            <div style="flex:1 1 200px">
              <b>${h.id}. ${esc(pick(h, 'name'))}</b>
              <div><span class="badge ${typeOf(h)}">${esc(typeLabel[typeOf(h)])}</span> <span class="small muted mlyStatus"></span></div>
              <div class="small muted">${h.lat.toFixed(5)}, ${h.lon.toFixed(5)} ·
                <a href="https://www.openstreetmap.org/?mlat=${h.lat}&mlon=${h.lon}#map=18/${h.lat}/${h.lon}" target="_blank" rel="noopener">OSM</a>
                ${h.mapillary_id ? ` · <a href="https://www.mapillary.com/app/?pKey=${encodeURIComponent(h.mapillary_id)}" target="_blank" rel="noopener">${esc(t('t_preview'))}</a>` : ''}</div>
            </div>
          </div>
          <div class="grid2">
            <div><label>${esc(t('t_mapillary_id'))}</label><input name="mly" type="text" value="${esc(h.mapillary_id || '')}"></div>
            <div><label>${esc(t('t_photo_url'))}</label><input name="photo" type="url" value="${esc(h.photo_url || '')}"></div>
            <div><label>${esc(t('t_photo_credit'))}</label><input name="credit" type="text" value="${esc(h.photo_credit || '')}"></div>
            <div><label>${esc(t('t_upload'))}</label><input name="file" type="file" accept="image/*"></div>
          </div>
          <div class="row">
            <label class="check" style="flex:1 1 auto"><input name="active" type="checkbox" ${h.active ? 'checked' : ''}> ${esc(t('t_active'))}</label>
            <button class="btn small primary" type="submit" style="flex:0 0 auto">${esc(t('t_save'))}</button>
          </div>
        </form>`).join('')}`;

    const save = async (f, h) => {
      await rpc('teacher_update_house', { p_id: h.id, p_photo_url: f.photo.value, p_photo_credit: f.credit.value, p_mapillary_id: f.mly.value, p_active: f.active.checked });
    };
    $all('[data-h]').forEach(f => {
      const h = houses.find(x => x.id === +f.dataset.h);
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        try {
          if (f.file.files[0]) { f.photo.value = await uploadBlob(await shrinkImage(f.file.files[0])); }
          await save(f, h); toast(t('t_saved')); renderHouses();
        } catch (e) { toast(errText(e)); }
      };
    });
    $('#mlyAll').onclick = async (ev) => {
      ev.target.disabled = true;
      for (const f of $all('[data-h]')) {
        const h = houses.find(x => x.id === +f.dataset.h);
        const st = f.querySelector('.mlyStatus'); st.textContent = '…';
        try {
          const best = await findMapillary(h.lat, h.lon);
          if (best && best.d <= 300) { f.mly.value = best.id; await save(f, h); st.textContent = t('t_found', { d: best.d }) + (best.pano ? ' (360°)' : ''); }
          else st.textContent = best ? t('t_found', { d: best.d }) + ' – ' + t('t_not_found') : t('t_not_found');
        } catch (e) { st.textContent = String(e.message || e); }
      }
      toast(t('t_done')); setTimeout(renderHouses, 1500);
    };
    $('#copyAll').onclick = async (ev) => {
      ev.target.disabled = true;
      for (const f of $all('[data-h]')) {
        const h = houses.find(x => x.id === +f.dataset.h);
        const st = f.querySelector('.mlyStatus');
        if (!/Special:FilePath/.test(h.photo_url || '')) continue;
        st.textContent = '…';
        try {
          const blob = await commonsToBlob(h.photo_url);
          if (blob) { f.photo.value = await uploadBlob(blob); await save(f, h); st.textContent = '✓'; }
        } catch (e) { st.textContent = String(e.message || e); }
      }
      toast(t('t_done')); renderHouses();
    };
  }

  init();
})();
