/* auth.js — Mole Meadow auth + leaderboard module
 * Exposes window.Auth; call window.Auth.init() once from game.js IIFE bottom.
 */
window.Auth = (() => {
  'use strict';

  const API       = 'https://whackamoleapi.tail18466c.ts.net';
  const TOKEN_KEY = 'mole-meadow-token';
  const USER_KEY  = 'mole-meadow-user';

  /* ── Session helpers ──────────────────────────────────────────────── */
  function getToken()   { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
  function getUser()    { try { return localStorage.getItem(USER_KEY);  } catch { return null; } }
  function isLoggedIn() { return !!getToken(); }

  function saveSession(token, username) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, username);
    } catch {}
  }

  function clearSession() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch {}
  }

  // Check if stored JWT is expired (client-side only, no signature check)
  function isTokenExpired() {
    const token = getToken();
    if (!token) return true;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.exp * 1000 < Date.now();
    } catch { return true; }
  }

  /* ── API calls ────────────────────────────────────────────────────── */
  async function register(username, password) {
    try {
      const res = await fetch(`${API}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || 'Registration failed' };
      saveSession(data.token, data.username);
      return { ok: true, username: data.username };
    } catch { return { ok: false, error: 'Could not reach the server' }; }
  }

  async function login(username, password) {
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || 'Login failed' };
      saveSession(data.token, data.username);
      return { ok: true, username: data.username };
    } catch { return { ok: false, error: 'Could not reach the server' }; }
  }

  async function submitScore(score, difficulty) {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(`${API}/scores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ score, difficulty })
      });
      if (res.status === 401) { clearSession(); renderAuthHeader(); }
    } catch (e) { console.warn('submitScore failed:', e.message); }
  }

  async function fetchLeaderboard(difficulty) {
    try {
      const url = difficulty ? `${API}/leaderboard?difficulty=${difficulty}` : `${API}/leaderboard`;
      const res = await fetch(url);
      if (!res.ok) return { ok: false, error: 'Server error' };
      const data = await res.json();
      return { ok: true, leaderboard: data.leaderboard };
    } catch { return { ok: false, error: 'Could not reach the server' }; }
  }

  /* ── DOM rendering ────────────────────────────────────────────────── */
  function renderAuthHeader() {
    const btn = document.getElementById('auth-login-btn');
    const grp = document.getElementById('auth-header-group');
    if (isLoggedIn()) {
      const username = getUser();
      if (btn) btn.remove();
      if (!grp) {
        const sound = document.getElementById('sound');
        const group = document.createElement('div');
        group.id = 'auth-header-group';
        group.className = 'auth-header-group';
        group.innerHTML = `<span class="auth-username"></span><button id="auth-logout-btn" class="auth-btn">Log out</button>`;
        group.querySelector('.auth-username').textContent = `👋 ${username}`;
        sound.parentNode.insertBefore(group, sound);
        document.getElementById('auth-logout-btn').addEventListener('click', logout);
      } else {
        grp.querySelector('.auth-username').textContent = `\uD83D\uDC4B ${username}`;
      }
    } else {
      if (grp) grp.remove();
      if (!document.getElementById('auth-login-btn')) {
        const sound = document.getElementById('sound');
        const loginBtn = document.createElement('button');
        loginBtn.id = 'auth-login-btn';
        loginBtn.className = 'auth-btn';
        loginBtn.textContent = 'Log in';
        sound.parentNode.insertBefore(loginBtn, sound);
        loginBtn.addEventListener('click', () => showModal(false));
      }
    }
  }

  function logout() { clearSession(); renderAuthHeader(); }

  /* ── Auth modal ───────────────────────────────────────────────────── */
  let _isRegisterMode = false;

  function showModal(registerMode) {
    _isRegisterMode = !!registerMode;
    const modal = document.getElementById('auth-modal-root');
    const title = document.getElementById('auth-modal-title');
    const submit = document.getElementById('auth-submit');
    const toggle = document.getElementById('auth-toggle');
    document.getElementById('auth-error').textContent = '';
    document.getElementById('auth-username-input').value = '';
    document.getElementById('auth-password-input').value = '';
    title.textContent  = _isRegisterMode ? 'Create account' : 'Log in';
    submit.textContent = _isRegisterMode ? 'Register' : 'Log in';
    toggle.textContent = _isRegisterMode ? 'Switch to Log in' : 'Switch to Register';
    modal.classList.remove('hidden');
    document.getElementById('auth-username-input').focus();
  }

  function hideModal() {
    document.getElementById('auth-modal-root').classList.add('hidden');
    const trigger = document.getElementById('auth-login-btn') || document.getElementById('auth-logout-btn');
    if (trigger) trigger.focus();
  }

  function renderLeaderboard(entries) {
    const tbody = document.getElementById('leaderboard-tbody');
    const status = document.getElementById('leaderboard-status');
    if (!tbody) return;
    if (!entries || entries.length === 0) {
      tbody.innerHTML = '';
      if (status) status.textContent = 'No scores yet — be the first!';
      return;
    }
    if (status) status.textContent = '';
    tbody.innerHTML = entries.map(e => `
      <tr>
        <td>${e.rank}</td>
        <td>${escHtml(e.username)}</td>
        <td>${e.score}</td>
        <td class="lb-diff lb-diff--${e.difficulty}">${e.difficulty}</td>
      </tr>`).join('');
  }

  function escHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  /* ── Inject DOM ───────────────────────────────────────────────────── */
  function injectDOM() {
    // Auth modal backdrop + card
    const backdrop = document.createElement('div');
    backdrop.id = 'auth-modal-root';
    backdrop.className = 'auth-modal-backdrop hidden';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-labelledby', 'auth-modal-title');
    backdrop.innerHTML = `
      <div class="auth-modal">
        <button id="auth-close" class="auth-close-btn" aria-label="Close">&times;</button>
        <h2 id="auth-modal-title">Log in</h2>
        <p id="auth-error" class="auth-error" role="alert"></p>
        <label for="auth-username-input">Username</label>
        <input id="auth-username-input" type="text" autocomplete="username"
               pattern="[a-zA-Z0-9_]{3,30}" minlength="3" maxlength="30" required />
        <label for="auth-password-input">Password</label>
        <input id="auth-password-input" type="password" autocomplete="current-password"
               minlength="8" maxlength="72" required />
        <button id="auth-submit" class="play-button" style="width:100%;margin-top:12px">Log in</button>
        <button id="auth-toggle" class="auth-toggle-btn">Switch to Register</button>
      </div>`;
    document.body.appendChild(backdrop);

    // Leaderboard panel — injected after .game-card
    const gameCard = document.querySelector('.game-card');
    const panel = document.createElement('section');
    panel.id = 'leaderboard-panel';
    panel.setAttribute('hidden', '');
    panel.innerHTML = `
      <h3 class="lb-title">\uD83C\uDFC6 Top 10 Meadow Bonkers</h3>
      <div class="lb-filters" role="group" aria-label="Filter by difficulty">
        <button class="lb-filter-btn lb-filter-btn--active" data-diff="">All</button>
        <button class="lb-filter-btn" data-diff="easy">Easy</button>
        <button class="lb-filter-btn" data-diff="medium">Medium</button>
        <button class="lb-filter-btn" data-diff="hard">Hard</button>
      </div>
      <p id="leaderboard-status" class="lb-status">Loading...</p>
      <table class="lb-table" aria-label="Leaderboard">
        <thead><tr><th>#</th><th>Player</th><th>Score</th><th>Difficulty</th></tr></thead>
        <tbody id="leaderboard-tbody"></tbody>
      </table>`;
    if (gameCard && gameCard.parentNode) {
      gameCard.parentNode.insertBefore(panel, gameCard.nextSibling);
    } else {
      document.querySelector('main').appendChild(panel);
    }

    // Leaderboard button in game-footer — wrapped alongside #restart
    const restart = document.getElementById('restart');
    if (restart) {
      const wrapper = document.createElement('div');
      wrapper.className = 'game-footer-right';
      restart.parentNode.insertBefore(wrapper, restart);
      wrapper.appendChild(restart);
      const lbBtn = document.createElement('button');
      lbBtn.id = 'leaderboard-btn';
      lbBtn.textContent = '\uD83C\uDFC6 Leaderboard';
      wrapper.appendChild(lbBtn);
    }
  }

  /* ── Wire events ──────────────────────────────────────────────────── */
  function wireEvents() {
    // Close modal
    document.getElementById('auth-close').addEventListener('click', hideModal);
    document.getElementById('auth-modal-root').addEventListener('click', e => {
      if (e.target === e.currentTarget) hideModal();
    });

    // Toggle register/login mode
    document.getElementById('auth-toggle').addEventListener('click', () => {
      _isRegisterMode = !_isRegisterMode;
      showModal(_isRegisterMode);
    });

    // Submit
    document.getElementById('auth-submit').addEventListener('click', async () => {
      const username = document.getElementById('auth-username-input').value.trim();
      const password = document.getElementById('auth-password-input').value;
      const errEl = document.getElementById('auth-error');
      errEl.textContent = '';
      const result = await (_isRegisterMode ? register(username, password) : login(username, password));
      if (!result.ok) { errEl.textContent = result.error; return; }
      hideModal();
      renderAuthHeader();
      refreshLeaderboard();
    });

    // Escape key closes modal
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !document.getElementById('auth-modal-root').classList.contains('hidden')) {
        hideModal();
      }
    });

    // Leaderboard toggle
    const lbBtn = document.getElementById('leaderboard-btn');
    if (lbBtn) {
      lbBtn.addEventListener('click', () => {
        const panel = document.getElementById('leaderboard-panel');
        if (panel.hasAttribute('hidden')) {
          panel.removeAttribute('hidden');
          refreshLeaderboard();
        } else {
          panel.setAttribute('hidden', '');
        }
      });
    }

    // Filter buttons
    document.querySelectorAll('.lb-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.lb-filter-btn').forEach(b => b.classList.remove('lb-filter-btn--active'));
        btn.classList.add('lb-filter-btn--active');
        refreshLeaderboard(btn.dataset.diff || undefined);
      });
    });
  }

  let _currentFilter;
  async function refreshLeaderboard(difficulty) {
    if (difficulty !== undefined) _currentFilter = difficulty || undefined;
    const data = await fetchLeaderboard(_currentFilter);
    const status = document.getElementById('leaderboard-status');
    if (!data.ok) {
      if (status) status.textContent = "Couldn\u2019t load the board \u2014 try again soon.";
      return;
    }
    renderLeaderboard(data.leaderboard);
  }

  /* ── init ─────────────────────────────────────────────────────────── */
  function init() {
    if (document.getElementById('auth-modal-root')) return; // guard: no double-init
    if (isTokenExpired()) clearSession();
    injectDOM();
    wireEvents();
    renderAuthHeader();
    // Fetch leaderboard silently on load
    refreshLeaderboard();
  }

  return {
    isLoggedIn, getUser,
    login, register, logout,
    submitScore, fetchLeaderboard, renderLeaderboard,
    refreshLeaderboard,
    init
  };
})();
