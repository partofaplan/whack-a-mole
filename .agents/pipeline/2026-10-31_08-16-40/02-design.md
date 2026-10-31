# Technical Design: Authentication, Score Saving, and Top-10 Leaderboard
*(Revision 2 — addresses all findings from design-review.json)*

## Overview

This design adds a Node.js/Express backend API service (`whackamoleapi`) to the existing K3d cluster and augments both frontend applications with login/register UI, automatic score submission, and a leaderboard panel. The backend is a single self-contained Express app that stores data in a SQLite file mounted from a Kubernetes PersistentVolumeClaim. Both frontends stay as static files served by their existing nginx containers; no build pipeline is introduced. The game logic IIFE in `game.js` (desktop) and `mobile/game.js` (mobile) is extended in-place — no bundler, no framework, no new dependencies on the front end. A shared `auth.js` module handles all API communication and is included via a `<script>` tag before `game.js` in each HTML file. `auth.js` lives at the repo root and is copied directly into the mobile Docker build context (no symlink). CSS additions follow the existing pattern: new rules appended to `style.css` and `mobile/style.css` using the same CSS custom properties (`--coral`, `--lime`, `--ink`, etc.) and the same `Fredoka One` / `Nunito` font stack.

---

## Technology Stack (locked)

| Layer | Choice | Reason |
|---|---|---|
| API runtime | Node.js 20 LTS (Alpine image) | Consistent with existing JS codebase; no new language |
| API framework | Express 4.19.2 | Minimal footprint; 4.19.x patches CVE-2024-29041 |
| Auth | `jsonwebtoken` + `bcryptjs` | `bcryptjs` is pure-JS — no native build step needed; JWT is standard |
| Database | `better-sqlite3` 9.4.3 | Synchronous API; bundles SQLite 3.45.x (supports `ROW_NUMBER()`); single-writer pairs cleanly with RWO PVC |
| Container | `node:20-alpine` multi-stage build | Smallest image; matches existing Alpine pattern |
| Persistent storage | Kubernetes PersistentVolumeClaim (ReadWriteOnce, 256Mi) | Matches requirements; SQLite single-writer constraint pairs cleanly with RWO |
| Ingress | Tailscale IngressClass (existing operator) | Matches all other ingresses; no new infrastructure |

---

## Backend API

### Directory layout

```
api/
  package.json
  package-lock.json
  server.js          # entry point; startup guard + middleware + routes
  db.js              # opens SQLite, runs migrations, exports db handle
  auth.js            # /auth/register + /auth/login route handlers
  scores.js          # /scores route handler
  leaderboard.js     # /leaderboard route handler
  middleware/
    authenticate.js  # JWT verification middleware
Dockerfile.api
k8s/
  api-deployment.yaml   # also contains the Service manifest (multi-doc YAML, ---)
  api-ingress.yaml
  api-pvc.yaml
```

### `db.js` — database initialisation

On startup `db.js` opens the SQLite file at the path set in `SQLITE_PATH` (default `/data/whackamoleapi.db`), executes `PRAGMA journal_mode=WAL` (safe for the single writer, allows concurrent reads), and runs the following migration inline (idempotent `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password   TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS scores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  score      INTEGER NOT NULL CHECK(score >= 0 AND score <= 9999),
  difficulty TEXT    NOT NULL CHECK(difficulty IN ('easy','medium','hard')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_scores_score      ON scores(score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_difficulty ON scores(difficulty, score DESC);
```

No migration library is needed at this scale. `db.js` accepts an optional `dbPath` argument (defaults to `process.env.SQLITE_PATH`) so tests can pass `':memory:'` for a fresh in-process database. `db.js` exports the open `better-sqlite3` database instance.

### `server.js` — startup guard and middleware stack

The very first thing `server.js` does, before any `require()` of route files or registration of middleware, is validate required environment variables:

```js
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set');
  process.exit(1);
}
```

This ensures the pod fails immediately at boot, before any routes are registered and before liveness/readiness probes can pass, if the secret is missing. The pod will never pass its readiness probe without a valid `JWT_SECRET`.

After the guard, the middleware stack is:

1. `express.json()` (body limit: `10kb`)
2. `cors()` — `origin` set to `['https://whackamole.tail18466c.ts.net', 'https://whackamolemobile.tail18466c.ts.net']`, `methods: ['GET','POST']`, `allowedHeaders: ['Content-Type','Authorization']`
3. `GET /health` — returns `{ status: 'ok', ts: Date.now() }` with HTTP 200. Registered before routes so it is always reachable even if a route file throws.
4. Routes: `POST /auth/register`, `POST /auth/login`, `POST /scores`, `GET /leaderboard`
5. 404 handler: `{ error: 'not found' }` with HTTP 404
6. Error handler: catches any thrown or `next(err)` error; logs `err.message` to stderr; returns `{ error: err.message }` with status from `err.status` or 500. Stack traces are suppressed in responses.

The server listens on port `3000` (plain HTTP; TLS is handled by the Tailscale ingress).

### `middleware/authenticate.js`

Reads `Authorization: Bearer <token>` from the request header. Verifies the token with `jwt.verify(token, process.env.JWT_SECRET)`. On success, sets `req.user = { id, username }` and calls `next()`. On failure (missing token, expired, invalid signature): calls `next({ status: 401, message: 'Unauthorized' })`. This middleware is applied per-route (not globally) so `/auth/*` and `/health` remain open.

### `auth.js` (backend) — registration and login

**POST /auth/register**

Input validation (all failures return HTTP 422 with `{ error: "<message>" }`):
- `username`: required, string, 3–30 chars, `/^[a-zA-Z0-9_]+$/` — if invalid: `"Username must be 3–30 alphanumeric characters or underscores"`
- `password`: required, string, 8–72 chars (72 is bcrypt's maximum useful length) — if invalid: `"Password must be 8–72 characters"`

Processing:
1. Check for existing username with a `SELECT id FROM users WHERE username = ? COLLATE NOCASE` prepared statement. If found: HTTP 409 `{ error: "Username already taken" }`.
2. Hash the password with `bcryptjs.hashSync(password, 10)` (cost 10 — satisfies NFR-1 minimum; at cost 10 on a modern CPU this takes ~80 ms, well within the probe `failureThreshold: 3` safety margin described in the deployment section).
3. Insert the user.
4. Sign a JWT: `jwt.sign({ id, username }, process.env.JWT_SECRET, { expiresIn: '7d', algorithm: 'HS256' })`.
5. Return HTTP 201 `{ token, username }`.

**POST /auth/login**

Input: same shape and validation as register (missing/invalid fields → HTTP 422).

Processing:
1. Fetch user by username (case-insensitive). If not found: HTTP 401 `{ error: "Invalid credentials" }` — same message as wrong password to prevent user enumeration.
2. `bcryptjs.compareSync(password, user.password)`. If false: HTTP 401 same message.
3. Sign and return JWT, HTTP 200 `{ token, username }`.

### `scores.js` — score submission

**POST /scores** — requires `authenticate` middleware.

Input validation (failures → HTTP 422):
- `score`: required, integer, 0–9999
- `difficulty`: required, one of `'easy'|'medium'|'hard'`

Processing: parameterised insert into `scores`. Returns HTTP 201 `{ id, username: req.user.username, score, difficulty, created_at }`.

On DB error (e.g. constraint violation): `next({ status: 500, message: 'Failed to save score' })`.

### `leaderboard.js` — leaderboard

**GET /leaderboard** — public, no auth required.

Query parameter: `difficulty` — optional, validated to be one of `'easy'|'medium'|'hard'`. Any other value → HTTP 422 `{ error: "difficulty must be easy, medium, or hard" }`.

The leaderboard returns one row per (user, difficulty) pair — the user's best score for that difficulty, not every submission. This matches Assumption 5 from the requirements and creates a fair top-10 that isn't monopolised by one prolific player.

`better-sqlite3` 9.4.3 bundles SQLite 3.45.x which supports `ROW_NUMBER()` (available since SQLite 3.25.0, 2018). No compatibility shim is needed.

Two prepared statements are created on module load — one for the global query, one for the difficulty-filtered query. The route selects between them based on whether `req.query.difficulty` is present.

SQL (global, no filter):
```sql
SELECT
  ROW_NUMBER() OVER (ORDER BY best_score DESC) AS rank,
  u.username,
  sub.best_score   AS score,
  sub.difficulty,
  sub.achieved_at  AS timestamp
FROM (
  SELECT
    user_id,
    difficulty,
    MAX(score)      AS best_score,
    MAX(created_at) AS achieved_at
  FROM scores
  GROUP BY user_id, difficulty
) sub
JOIN users u ON u.id = sub.user_id
ORDER BY best_score DESC
LIMIT 10
```

`MAX(created_at)` is used so the timestamp reflects the most recent attempt for that difficulty, not the user's first ever submission. When `difficulty` is provided, a `WHERE sub.difficulty = ?` clause is added between the subquery CTE and the outer `ORDER BY`. Returns HTTP 200 `{ leaderboard: [...] }`.

`better-sqlite3` executes this synchronously; with indexes in place it will complete well under the 200 ms budget on K3d single-node.

### `package.json`

```json
{
  "name": "whackamoleapi",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "bcryptjs": "2.4.3",
    "better-sqlite3": "9.4.3",
    "cors": "2.8.5",
    "express": "4.19.2",
    "jsonwebtoken": "9.0.2"
  }
}
```

Exact versions are pinned. `package-lock.json` is committed.

---

## Dockerfile.api

`better-sqlite3` compiles a native addon via `node-gyp`, which requires `python3`, `make`, and `g++`. These are not present in the base `node:20-alpine` image. They are installed in the `deps` stage only; the final stage copies the already-built `node_modules` (including the compiled `.node` binary linked against `musl`) without needing the build tools present at runtime.

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY api/ ./
ENV NODE_ENV=production
ENV PORT=3000
ENV SQLITE_PATH=/data/whackamoleapi.db
EXPOSE 3000
CMD ["node", "server.js"]
```

The image tag for k3d import is `whackamoleapi:latest`.

---

## Kubernetes Manifests

### `k8s/api-pvc.yaml`

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: whackamoleapi-data
  namespace: whack-a-mole
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 256Mi
```

### `k8s/api-deployment.yaml`

Contains both the Deployment and Service as a multi-document YAML (separated by `---`), following the same pattern as the existing `deployment.yaml`.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: whackamoleapi
  namespace: whack-a-mole
  labels:
    app: whackamoleapi
spec:
  replicas: 1          # single replica required by SQLite RWO constraint
  selector:
    matchLabels:
      app: whackamoleapi
  template:
    metadata:
      labels:
        app: whackamoleapi
    spec:
      containers:
        - name: whackamoleapi
          image: whackamoleapi:latest
          imagePullPolicy: Never
          ports:
            - containerPort: 3000
          env:
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: whackamoleapi-jwt-secret
                  key: secret
          volumeMounts:
            - name: data
              mountPath: /data
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 15
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 3
            periodSeconds: 10
            failureThreshold: 3
          resources:
            requests:
              cpu: 20m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: whackamoleapi-data
---
apiVersion: v1
kind: Service
metadata:
  name: whackamoleapi
  namespace: whack-a-mole
  labels:
    app: whackamoleapi
spec:
  type: ClusterIP
  selector:
    app: whackamoleapi
  ports:
    - name: http
      port: 80
      targetPort: 3000
```

The explicit `failureThreshold: 3` makes the probe tolerance visible in the manifest. At bcrypt cost 10 (~80 ms per registration call) and `periodSeconds: 10`, even three simultaneous registrations would not cause consecutive probe failures within the threshold window. This is documented explicitly rather than left implicit.

### `k8s/api-ingress.yaml`

Follows the exact same pattern as `k8s/ingress.yaml` and `k8s/mobile-ingress.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: whackamoleapi
  namespace: whack-a-mole
  labels:
    app: whackamoleapi
  annotations:
    tailscale.com/funnel: "false"
spec:
  ingressClassName: tailscale
  defaultBackend:
    service:
      name: whackamoleapi
      port:
        name: http
  tls:
    - hosts:
        - whackamoleapi
```

### Pre-deployment secret creation (operator runs manually before `kubectl apply`)

```bash
kubectl create secret generic whackamoleapi-jwt-secret \
  --namespace whack-a-mole \
  --from-literal=secret="$(openssl rand -hex 32)"
```

This must be run before the Deployment is applied. Without it, the startup guard (`process.exit(1)`) fires and the pod will crash-loop, which is the correct fail-fast behaviour.

---

## Dockerfile updates

**`Dockerfile`** (desktop) — adds `auth.js` from the repo root:
```dockerfile
FROM nginx:alpine
COPY index.html style.css game.js auth.js /usr/share/nginx/html/
EXPOSE 80
```

**`Dockerfile.mobile`** — copies `auth.js` directly from the repo root (no symlink, no `mobile/auth.js` intermediate file):
```dockerfile
FROM nginx:alpine
COPY auth.js /usr/share/nginx/html/auth.js
COPY mobile/index.html mobile/style.css mobile/game.js /usr/share/nginx/html/
EXPOSE 80
```

`auth.js` lives at the repo root. Both Dockerfiles copy it from that single source of truth. There is no `mobile/auth.js` file in the repository — the `Dockerfile.mobile` copies the root `auth.js` directly into the container's html directory. This eliminates the sync problem entirely.

---

## Frontend: Shared `auth.js` module

Both `index.html` and `mobile/index.html` gain a `<script src="auth.js"></script>` tag inserted immediately before the existing `<script src="game.js"></script>`. `auth.js` exposes a single global `window.Auth` object (IIFE pattern) and creates all required DOM by injection — no HTML file changes are needed beyond adding the `<script>` tag.

```js
window.Auth = (() => {
  'use strict';
  const API = 'https://whackamoleapi.tail18466c.ts.net';
  const TOKEN_KEY = 'mole-meadow-token';
  const USER_KEY  = 'mole-meadow-user';

  function getToken()   { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
  function getUser()    { try { return localStorage.getItem(USER_KEY);  } catch { return null; } }
  function isLoggedIn() { return !!getToken(); }
  function saveSession(token, username) {
    try { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, username); } catch {}
  }
  function clearSession() {
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch {}
  }

  // logout updates DOM as well as clearing storage
  function logout() { clearSession(); renderAuthHeader(); }

  async function register(username, password) { /* POST /auth/register → { ok, error, token, username } */ }
  async function login(username, password)    { /* POST /auth/login    → { ok, error, token, username } */ }
  async function submitScore(score, difficulty) { /* fire-and-forget POST /scores; returns Promise */ }
  async function fetchLeaderboard(difficulty)   { /* GET /leaderboard[?difficulty=…] → { ok, leaderboard, error } */ }

  function renderLeaderboard(entries) { /* populates #leaderboard-table */ }
  function renderAuthHeader()         { /* updates header button to username+logout or "Log in" */ }

  function init() {
    // Guard: do not double-inject if called more than once
    if (document.getElementById('auth-modal-root')) return;
    // Inject modal root and leaderboard panel root into <main>
    // Inject auth button into <header>
    // Wire up all event listeners
    renderAuthHeader();
    // Check for an expired token on page load (client-side decode only, no signature check)
    // If expired → clearSession() silently → guest mode
  }

  return {
    isLoggedIn, getUser, login, register, logout,
    submitScore, fetchLeaderboard, renderLeaderboard, init
  };
})();
```

Key points:
- `renderLeaderboard` is explicitly part of the `return` statement, exposing it on `window.Auth`.
- `logout` is a wrapper that calls both `clearSession()` and `renderAuthHeader()`, so the header updates immediately without a page reload.
- `init()` guards against double-invocation: `if (document.getElementById('auth-modal-root')) return;` is the first line. This is safe because `init()` is called once at the bottom of the `game.js` IIFE and never from `start()`.

### Call site for `init()`

`auth.js` is loaded before `game.js` in `<body>`, meaning `window.Auth` is defined before the `game.js` IIFE executes. At the bottom of the `game.js` IIFE (after `setDifficulty(difficulty)`, the last existing setup call), add:

```js
if (window.Auth) window.Auth.init();
```

Both scripts are loaded at the end of `<body>`, so all HTML elements are already in the DOM when this line runs. **No `DOMContentLoaded` wrapper is needed or should be added.** The `init()` description above ("called once on DOMContentLoaded") from the previous design revision was incorrect and is removed. The call is bare, at IIFE bottom, which is correct.

`score` and `difficulty` are already in scope inside `finish()` because the injected lines are added directly into the same IIFE closure. No changes to variable scoping are needed — no `window.score` or similar hoisting.

### Auth modal

The modal is implemented as a `<div role="dialog">` overlay rather than a native `<dialog>` element. This avoids the `showModal()` compatibility gap (native `<dialog>` requires Safari 15.4+, which excludes iOS 14 and iOS 15.0–15.3). A `<div>`-based overlay works universally across all browsers in the game's target audience.

The overlay div:
- Has `role="dialog"`, `aria-modal="true"`, and `aria-labelledby` pointing to the modal heading
- Uses `position:fixed; inset:0; z-index:100; display:flex` for full-screen centering
- Is shown/hidden by toggling a `.hidden` CSS class (matching the pattern used by `$('overlay').hidden` in `game.js`)
- Traps focus using a short JS focus-trap: on `keydown`, if `Tab` or `Shift+Tab` would move focus outside the modal, redirect it to the first/last focusable element; `Escape` closes the modal and returns focus to the trigger button

Contents:
- `<h2 id="auth-modal-title">` for the accessible name (Log in / Register)
- `<input id="auth-username">` — required, pattern `[a-zA-Z0-9_]{3,30}`
- `<input id="auth-password" type="password">` — required, minlength 8
- `<p id="auth-error" role="alert">` for inline error display (live region)
- `<button id="auth-submit">` — "Log in" or "Register" depending on mode
- `<button id="auth-toggle">` — "Switch to Register" / "Switch to Log in"
- `<button id="auth-close" aria-label="Close">` ×

On success: `renderAuthHeader()` updates the header, the modal is hidden, the leaderboard refreshes.

The auth button injected into the header is a `<button id="auth-login-btn" class="auth-btn">`. The header uses `justify-content: space-between` with three existing flex children: `.brand`, `.header-note`, and `#sound`. The auth button is inserted **before** `#sound` (using `insertBefore`) rather than appended after it, so it sits between the header note and the sound button. On mobile where `.header-note` is hidden via CSS, this places the auth button naturally beside the sound button with no layout disruption. When logged in, the button is replaced with a `<span class="auth-username">` + `<button id="auth-logout-btn">` pair wrapped in a `<div class="auth-header-group">`.

### Leaderboard panel

A `<section id="leaderboard-panel" hidden>` is injected into `<main>` after `.game-card`. A trigger button `<button id="leaderboard-btn">` is appended into `.game-footer`. The `.game-footer` currently uses `justify-content: space-between` with two children (the hint `<span>` on the left and `#restart` on the right). To place the leaderboard button beside `#restart`, both buttons are wrapped in a `<div class="game-footer-right" style="display:flex;gap:8px">` created by `init()`. This is injected by the JS, not by changing the HTML file. The result: hint text on the left, two buttons on the right, visually consistent.

When `#leaderboard-btn` is clicked, `leaderboard-panel` is shown/hidden by toggling the `hidden` attribute.

The panel contains:
- A heading "Top 10 Meadow Bonkers"
- Difficulty filter buttons (All / Easy / Medium / Hard) styled like `.difficulty-btn`
- A `<table id="leaderboard-table">` with columns: Rank, Player, Score, Difficulty
- A loading/empty state `<p id="leaderboard-status">`

`renderLeaderboard(entries)` is called:
1. From `finish()` in `game.js` after every round (whether or not the player is logged in — the leaderboard is always public)
2. Whenever a filter button is clicked

`window.Auth.renderLeaderboard` is on the public API surface and called via that path in `game.js`.

### Changes to `game.js` (desktop) and `mobile/game.js` (mobile)

Both files are structurally identical IIFEs. The changes are surgical — the IIFE structure and all existing logic are untouched.

**1. At the end of `function finish()`**, after the existing overlay and status update lines, add:

```js
// Authenticated score submission — fire-and-forget
if (window.Auth && window.Auth.isLoggedIn()) {
  window.Auth.submitScore(score, difficulty);
}
// Leaderboard refresh after every round (public, no auth needed)
if (window.Auth) {
  window.Auth.fetchLeaderboard().then(data => {
    if (data.ok) window.Auth.renderLeaderboard(data.leaderboard);
  });
}
```

`score` and `difficulty` are the IIFE-scoped `let` variables already in scope at `finish()`. No variable hoisting or renaming is required. `submitScore` is intentionally fire-and-forget — its Promise is not awaited. A network failure silently discards and never disrupts the overlay.

**2. At the bottom of the IIFE**, after `setDifficulty(difficulty)` (the last existing setup line), add:

```js
if (window.Auth) window.Auth.init();
```

`auth.js` is loaded before `game.js` so `window.Auth` is always defined when this line runs.

### CSS additions

New rules are appended to `style.css` and `mobile/style.css`:

- `.auth-btn` — same border, border-radius, and font as `.sound` (transparent background, `border: 2px solid var(--lime)`, Nunito)
- `.auth-header-group` — `display:flex; align-items:center; gap:8px`
- `.auth-username` — `font-family:'Nunito'; font-size:11px; font-weight:700; color:var(--ink)`
- `.auth-modal-backdrop` — `position:fixed; inset:0; background:rgba(26,31,54,.55); z-index:99; display:flex; align-items:center; justify-content:center`
- `.auth-modal` — card style matching `.game-card`: `border:3px solid var(--lime); border-radius:24px; background:#fff; padding:24px; box-shadow:0 8px 0 #1a9e2e; max-width:360px; width:90%`
- `.auth-modal.hidden, .auth-modal-backdrop.hidden` — `display:none`
- `#leaderboard-panel` — card style matching `.game-card`; `margin-top:16px; padding:16px`
- `#leaderboard-panel[hidden]` — `display:none`
- `.leaderboard-table` — full-width table; Nunito font; `th` using `var(--muted)` at `9px/1.5px letter-spacing`; alternating `#f0fdf4` row backgrounds matching the scoreboard boxes
- `.leaderboard-filter` — `display:flex; gap:8px; margin:10px 0`; filter buttons use `.difficulty-btn` visual style
- `.game-footer-right` — `display:flex; gap:8px; align-items:center`

Mobile CSS appends to `mobile/style.css` with touch-friendly tap targets (min 44px height on all buttons), full-width modal (`.auth-modal { max-width:none; width:calc(100% - 32px) }`), and the leaderboard panel full-width (`max-width:none`).

---

## Error Handling Matrix

| Operation | Failure condition | Recoverable? | Response to caller | Logged? |
|---|---|---|---|---|
| DB open / migration | `SQLITE_PATH` unwritable; bad schema | Fatal — process exits | — | stderr (crash) |
| `JWT_SECRET` absent | Missing env var | Fatal — process exits at startup | Pod crash-loops; readiness probe never passes | stderr |
| Register — duplicate username | Unique constraint race | Recoverable | HTTP 409 `{ error: "Username already taken" }` | No |
| Register — DB other | Unexpected DB error | Recoverable | HTTP 500 `{ error: "Registration failed" }` | stderr |
| Login — user not found | No row for username | Recoverable | HTTP 401 `{ error: "Invalid credentials" }` | No |
| Login — wrong password | bcrypt compare false | Recoverable | HTTP 401 `{ error: "Invalid credentials" }` | No |
| Login — DB query error | Unexpected DB error | Recoverable | HTTP 500 `{ error: "Login failed" }` | stderr |
| JWT verify (middleware) | Missing, expired, or invalid token | Recoverable | HTTP 401 `{ error: "Unauthorized" }` | No |
| Score insert — validation | Bad score/difficulty value | Recoverable | HTTP 422 (caught before DB) | No |
| Score insert — DB error | Unexpected | Recoverable | HTTP 500 `{ error: "Failed to save score" }` | stderr |
| Leaderboard query | DB error | Recoverable | HTTP 500 `{ error: "Leaderboard unavailable" }` | stderr |
| `submitScore` (frontend) | Network error / 4xx / 5xx | Recoverable — silently ignored | None (fire-and-forget) | `console.warn` |
| `fetchLeaderboard` (frontend) | Network error | Recoverable — panel shows message | `"Couldn't load the board — try again soon."` | No |
| Modal login/register (frontend) | API returns error | Recoverable | Error shown in `#auth-error` (live region) | No |
| Expired token on page load | Client-side `exp` check | Recoverable | `clearSession()` → silent guest mode | No |

---

## Input Validation Summary

| Field | Required | Type | Constraints | Failure |
|---|---|---|---|---|
| `username` (register/login) | Yes | string | 3–30 chars, `[a-zA-Z0-9_]` | HTTP 422 |
| `password` (register/login) | Yes | string | 8–72 chars | HTTP 422 |
| `score` (submit) | Yes | integer | 0 ≤ score ≤ 9999 | HTTP 422 |
| `difficulty` (submit) | Yes | string | `easy\|medium\|hard` | HTTP 422 |
| `difficulty` (leaderboard) | No | string | `easy\|medium\|hard` if present | HTTP 422 |

All validation runs in the route handler before any database access. Express's `req.body` parsing uses `express.json()` with a 10 KB body limit; a payload exceeding this returns HTTP 413 automatically.

---

## Testability Notes

`db.js` accepts an optional path argument so tests can pass `':memory:'` to get a fresh in-process SQLite database per test. Route handlers receive the `db` instance via a constructor function (`module.exports = (db) => router`), not a global import, so each test can inject a test DB. The `authenticate` middleware can be bypassed in unit tests by mounting the router with a fake `req.user`.

Frontend `auth.js` has no build step; its functions can be tested in Node.js using `jsdom` + `fetch` mock. Integration tests cover the full `POST /auth/register` → `POST /scores` → `GET /leaderboard` cycle against a `':memory:'` SQLite instance.

---

## Deployment Order

1. Create the JWT secret (manual, once):
   ```bash
   kubectl create secret generic whackamoleapi-jwt-secret \
     --namespace whack-a-mole \
     --from-literal=secret="$(openssl rand -hex 32)"
   ```
2. `kubectl apply -f k8s/api-pvc.yaml`
3. Build API image: `docker build -f Dockerfile.api -t whackamoleapi:latest .`
4. Import: `k3d image import whackamoleapi:latest -c hercules`
5. `kubectl apply -f k8s/api-deployment.yaml` (creates both Deployment and Service)
6. `kubectl apply -f k8s/api-ingress.yaml`
7. Rebuild desktop: `docker build -f Dockerfile -t whack-a-mole:latest .`
8. Import: `k3d image import whack-a-mole:latest -c hercules`
9. `kubectl rollout restart deployment/whack-a-mole -n whack-a-mole`
10. Rebuild mobile: `docker build -f Dockerfile.mobile -t whackamole-mobile:latest .`
11. Import: `k3d image import whackamole-mobile:latest -c hercules`
12. `kubectl rollout restart deployment/whackamole-mobile -n whack-a-mole`
13. Verify: `kubectl get pods -n whack-a-mole` (all Running), `kubectl get ingress -n whack-a-mole` (all have addresses)

Note: There is no `mobile/auth.js` file to create. `Dockerfile.mobile` copies `auth.js` directly from the repo root in step 10.

---

## Edge Cases

- **Race condition on registration**: Two simultaneous registrations with the same username. The `UNIQUE` constraint on `users.username` catches the second insert; the route returns HTTP 409. No user is duplicated.
- **Expired JWT on page reload**: `Auth.init()` calls `jwt.decode()` client-side (no signature check) to read the `exp` claim. If the token is expired, `clearSession()` is called silently and the player is in guest mode. The full signature verification happens server-side on every authenticated request.
- **Zero-score round**: A score of 0 is a valid submission (the player played but missed everything). The schema allows `score >= 0`.
- **Leaderboard with fewer than 10 entries**: The `LIMIT 10` SQL simply returns fewer rows; the frontend renders however many arrive.
- **Pod restart / DB file persistence**: The PVC mount at `/data` survives pod deletion. K3d uses `local-path` provisioner by default; the PVC is bound to node-local storage which persists across pod restarts in single-node K3d.
- **Guest mode**: All auth functions in `window.Auth` guard on `isLoggedIn()`. The game's `finish()` function checks `window.Auth.isLoggedIn()` before calling `submitScore`. The leaderboard panel is always visible and readable regardless of login state — `GET /leaderboard` requires no auth.
- **Modal opened during active game**: The modal overlay sits above the field (z-index 99+). Opening the modal does not call `start()` or `finish()`, so the running game timer continues — but the game field is obscured. The "Log in" button is in the header; opening it mid-game is a player choice. No game state changes.
- **CORS on preflight**: Express `cors()` middleware automatically handles `OPTIONS` preflight for `POST /auth/*` and `POST /scores`. The `allowedHeaders` list includes `Authorization` to permit the Bearer token header.
- **`better-sqlite3` native addon on Alpine**: The `deps` stage installs `python3 make g++` via `apk` before `npm ci`, so `node-gyp` can compile the addon. The final stage copies the compiled `node_modules` without the build tools. The `.node` file is linked against `musl` libc, which matches the Alpine runtime.
- **`auth.js` copied in mobile Docker build**: `Dockerfile.mobile` copies `auth.js` from the repo root directly. If `auth.js` is ever modified, rebuilding the mobile image picks up the change automatically — there is no separate `mobile/auth.js` that could drift out of sync.

---

## Responses to Design Review Findings

### HIGH Findings

**Finding 1 — `Auth.init()` DOMContentLoaded contradiction**
Addressed. Removed all "DOMContentLoaded" language from `init()` description. The design now explicitly states: both scripts are at end of `<body>`, all elements are already parsed when the IIFE bottom runs, and no `DOMContentLoaded` wrapper is needed or should be added.

**Finding 2 — `better-sqlite3` native addon missing build tools**
Addressed. `Dockerfile.api` `deps` stage now includes `RUN apk add --no-cache python3 make g++` before `npm ci`.

**Finding 3 — `renderLeaderboard` bare name not in scope**
Addressed. All `renderLeaderboard(...)` calls in the `finish()` snippet now read `window.Auth.renderLeaderboard(data.leaderboard)`. `renderLeaderboard` is explicitly in the `return { ... }` statement of `window.Auth`.

**Finding 4 — `mobile/auth.js` copy never created**
Addressed. The approach is changed: `Dockerfile.mobile` copies `auth.js` directly from the repo root using `COPY auth.js /usr/share/nginx/html/auth.js`. There is no `mobile/auth.js` file to create or sync. The deployment order note confirms this.

### MEDIUM Findings

**Finding 5 — SQLite `ROW_NUMBER()` compatibility not confirmed**
Addressed. Added explicit statement: "`better-sqlite3` 9.4.3 bundles SQLite 3.45.x which supports `ROW_NUMBER()`. No compatibility shim is needed."

**Finding 6 — `score`/`difficulty` scope not confirmed for mobile**
Addressed. Added explicit statement: "`score` and `difficulty` are the IIFE-scoped `let` variables already in scope at `finish()`. No variable hoisting or renaming is required." This applies to both desktop and mobile IIFEs (verified: both are structurally identical).

**Finding 7 — JWT startup validation not actually fatal**
Addressed. `server.js` now has an explicit startup guard (`if (!process.env.JWT_SECRET) { console.error(...); process.exit(1); }`) as the very first lines, before routes are registered. Pod will crash-loop, readiness probe will never pass.

**Finding 8 — `<dialog>` / `showModal()` not supported on iOS < 15.4**
Addressed. Replaced `<dialog>` with a `<div role="dialog">` overlay. Custom focus-trap (Tab/Shift+Tab/Escape handling) is specified. Works universally across all browsers.

**Finding 9 — Leaderboard button layout impact on `.game-footer`**
Addressed. `init()` wraps `#restart` and the new `#leaderboard-btn` in a `<div class="game-footer-right">` (`display:flex; gap:8px`). This keeps the hint text on the left and both buttons on the right without disrupting `justify-content: space-between`.

**Finding 10 — bcrypt cost 12 blocks event loop**
Addressed. Cost lowered to 10 (satisfies NFR-1 minimum; ~80 ms on modern CPU). `failureThreshold: 3` added explicitly to both liveness and readiness probe specs. Risk tradeoff documented in the Deployment section.

### NIT Findings

**Finding 11 — Express 4.18.3 CVE**
Addressed. `express` version changed to `4.19.2` in `package.json`.

**Finding 12 — `logout` alias doesn't update UI**
Addressed. `logout` is now a wrapper function `function logout() { clearSession(); renderAuthHeader(); }`, not a direct alias for `clearSession`.

**Finding 13 — `api-deployment.yaml` contains Service — not noted in directory layout**
Addressed. Directory layout comment updated: `api-deployment.yaml   # also contains the Service manifest (multi-doc YAML, ---)`.

**Finding 14 — `MIN(created_at)` shows first submission, not best-score date**
Addressed. Changed to `MAX(created_at) AS achieved_at` and renamed the column to `achieved_at` for clarity. The timestamp now reflects the most recent attempt for that user+difficulty, which is a reasonable proxy for "when they last set or improved their best score."

**Finding 15 — `init()` not stated to be idempotent**
Addressed. `init()` now explicitly states: `if (document.getElementById('auth-modal-root')) return;` is the first line, guarding against double-invocation.
