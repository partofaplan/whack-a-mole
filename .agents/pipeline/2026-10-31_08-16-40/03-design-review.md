# Design Review: Authentication, Score Saving, and Top-10 Leaderboard

Reviewed against:
- Requirements: `01-requirements.md`
- Design: `02-design.md`
- Source code: `/Users/zachperkins/repos/whack-a-mole` (verified directly)

---

## Findings

### HIGH

**1. [HIGH] `auth.js` injection point in `game.js` IIFE is wrong — `Auth.init()` will be called before the DOM is ready**

Location: "Changes to `game.js`" section; the proposed hook is `if (window.Auth) window.Auth.init();` placed "after the closing `setDifficulty(difficulty)` call."

The actual `game.js` (verified) is a self-invoking IIFE that runs synchronously during script parsing — the `<body>` has not finished at that point. The design places the `<script src="auth.js">` before `<script src="game.js">`, so `Auth.init()` called at the bottom of the IIFE runs before `DOMContentLoaded`. The design's own description of `Auth.init()` says it is "called once on `DOMContentLoaded`", but the proposed call site is *not* inside a `DOMContentLoaded` listener. Because both scripts are in `<body>` *after* all the HTML elements, the DOM is actually parsed by the time inline scripts at end of `<body>` run — this works in practice. However the design is self-contradictory: `init()` says "called once on DOMContentLoaded" while the actual call is naked at IIFE bottom. The implementation agent will be confused and may wrap the call in a `DOMContentLoaded` listener (wrong — elements already exist) or call it bare (correct but inconsistently documented).

**Concrete fix:** Remove the phrase "called once on DOMContentLoaded" from `auth.js`'s `init()` description. Clarify: "`init()` is called at the bottom of the `game.js` IIFE, after all DOM setup, because both scripts are loaded at end of `<body>` where the HTML elements are already parsed. No `DOMContentLoaded` wrapper is needed or should be added."

---

**2. [HIGH] `better-sqlite3` native addon requires `python3` + `make` + `g++` in the Alpine build stage — the Dockerfile does not install them, and `npm ci` will fail**

Location: `Dockerfile.api` section.

`better-sqlite3` compiles a native addon via `node-gyp`. The base `node:20-alpine` image does not ship Python 3, make, or g++. `npm ci` in the `deps` stage will fail with a build error. The design acknowledges the native compilation requirement ("The package uses native bindings. The multi-stage Dockerfile builds inside the same Alpine image that runs the code") but does not provide the build dependencies.

**Concrete fix:** Change the `deps` stage to install build tools before `npm ci`:

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev
```

---

**3. [HIGH] `game.js` IIFE closure: `score` and `difficulty` variables used in the injected `finish()` hook are local variables — they ARE accessible, but `renderLeaderboard` is not defined in `game.js` scope and the design is ambiguous about where it lives**

Location: "Changes to `game.js`" section.

The injected snippet calls `renderLeaderboard(data.leaderboard)` inside `finish()`. But `renderLeaderboard` is stated to be "defined in `auth.js` (or called via `window.Auth.renderLeaderboard`)". This is a contradictory, open "or": the snippet shows a bare `renderLeaderboard(...)` call (implying a local function), but `auth.js` as a separate file has no access to the IIFE's scope. If `renderLeaderboard` is a bare local name, it does not exist. If it is `window.Auth.renderLeaderboard`, the snippet must say so. The parenthetical "(or called via `window.Auth.renderLeaderboard`)" leaves the implementation agent to guess.

**Concrete fix:** Remove the ambiguity. The snippet in `finish()` should read:

```js
if (window.Auth) {
  window.Auth.fetchLeaderboard().then(data => {
    if (data.ok) window.Auth.renderLeaderboard(data.leaderboard);
  });
}
```

`renderLeaderboard` must be exposed on `window.Auth` and listed in its public surface (it is currently absent from the `return { ... }` statement shown in the design).

---

**4. [HIGH] The design does not specify how `auth.js` is deployed to the mobile nginx container — the described approach contradicts itself**

Location: "Dockerfile updates" section.

The design says "`mobile/auth.js` is a symlink to `../auth.js` — or a copy if symlinks cause Docker build issues. Decision: use a copy." Then in `Dockerfile.mobile` it writes:

```dockerfile
COPY mobile/index.html mobile/style.css mobile/game.js mobile/auth.js /usr/share/nginx/html/
```

This requires `mobile/auth.js` to exist at build time. But there is no `mobile/auth.js` in the repository today (verified). The design does not create it — it only says "the implementation agent creates `mobile/auth.js` as a copy." That instruction is buried in prose and is not part of the deployment order (13 steps, no mention of creating this file). If the implementation agent forgets, `docker build` for mobile fails.

**Concrete fix:** Add an explicit step to the deployment order:

> Step 2.5: `cp auth.js mobile/auth.js` (or add this to `Dockerfile.mobile` as a `COPY auth.js /auth.js` then `RUN cp /auth.js /usr/share/nginx/html/auth.js`). Note that whenever `auth.js` is modified, `mobile/auth.js` must be regenerated.

Alternatively, keep `auth.js` at the repo root and in `Dockerfile.mobile` copy it directly:

```dockerfile
COPY auth.js /usr/share/nginx/html/auth.js
COPY mobile/index.html mobile/style.css mobile/game.js /usr/share/nginx/html/
```

This is simpler and avoids the sync problem entirely.

---

### MEDIUM

**5. [MEDIUM] The leaderboard SQL uses `ROW_NUMBER() OVER (...)` — SQLite supports window functions only from version 3.25.0 (2018). The Alpine `node:20-alpine` ships with a bundled `better-sqlite3` that uses its own SQLite, but the design does not verify this is ≥ 3.25.0**

Location: `leaderboard.js` SQL section.

`better-sqlite3` bundles its own SQLite (not the system one), so this should be safe, but the design states the query is compatible without verifying the bundled version. `better-sqlite3` 9.4.3 bundles SQLite 3.45.x which supports window functions. This is verifiable but the design does not confirm it, leaving a silent risk.

**Concrete fix:** Add one sentence to the leaderboard section: "`better-sqlite3` 9.4.3 bundles SQLite 3.45.x which supports `ROW_NUMBER()`. No compatibility shim is needed."

---

**6. [MEDIUM] The `score` variable captured in `finish()` is the IIFE-scoped `score` (integer), but the `submitScore` call also needs `difficulty` — both are IIFE-local variables. The design's snippet works for the desktop IIFE but does not explicitly confirm this for `mobile/game.js`, which has an identical but separate IIFE**

Location: "Changes to `game.js` (desktop) and `mobile/game.js` (mobile)" section.

The design says "The changes are surgical — the IIFE structure and all existing logic are untouched" and treats both files identically. Verified: both IIFEs expose `score` and `difficulty` as local `let` variables and `finish()` is declared inside those same IIFEs. The injected snippet will have access. This is technically fine, but the design does not confirm this explicitly; it only says "changes are surgical." An implementation agent could mistakenly add `window.score` assignments or hoist variables unnecessarily.

**Concrete fix:** Add one sentence: "`score` and `difficulty` are already in scope inside `finish()` because the injected lines are added directly into the same IIFE closure. No changes to variable scoping are needed."

---

**7. [MEDIUM] JWT startup validation is described informally and incompletely — "Fatal — caught at startup" for missing `JWT_SECRET` is not actually implemented by `jsonwebtoken`; the process will only crash when the first sign call is made**

Location: Error Handling Matrix, row "JWT sign — Missing `JWT_SECRET` env var — Fatal — process exits".

`jsonwebtoken.sign()` with an undefined secret throws `Error: secretOrPrivateKey must have a value` at call time, not at process start. The design implies the server validates the secret on startup and exits, but neither `server.js` nor `auth.js` pseudo-code shows an explicit startup check. Under the current design, the pod would start successfully, pass liveness/readiness probes (since `/health` is registered first and requires no JWT), and only fail on the first login/register attempt.

**Concrete fix:** Add an explicit startup guard in `server.js`:

```js
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set');
  process.exit(1);
}
```

This should run before routes are registered, so the pod fails fast and the readiness probe never passes without a valid secret.

---

**8. [MEDIUM] The `<dialog>` modal requires `HTMLDialogElement` support — not available in all browsers the mobile frontend targets. No polyfill or fallback is mentioned**

Location: "Auth modal" section.

`<dialog>` with `showModal()` is widely supported in modern browsers (Chrome 37+, Firefox 98+, Safari 15.4+) but the design does not state a minimum browser target. For a mobile game aimed at a broad audience (the requirements say "mobile-friendly"), Safari 15.4 was released in March 2022. Devices on iOS 14 or 15.3 will see a broken modal. The design claims `showModal()` provides "built-in focus trapping and Escape key handling at no extra cost" without addressing the compatibility gap.

**Concrete fix:** Either (a) add a compatibility note ("Requires Safari 15.4+ / Chrome 37+ / Firefox 98+; below that the modal degrades to `display:flex` overlay") and a feature detect + graceful fallback, or (b) use a plain `<div role="dialog">` overlay that works universally and implement focus trapping manually (a few lines of JS). Specify which choice is made.

---

**9. [MEDIUM] The `game-footer` element in `index.html` does not have a `.game-footer` class element that the design can reliably use to inject the leaderboard button "right side, beside the existing `restart` button"**

Location: "Leaderboard panel" section; verified against `index.html`.

Verified: the HTML contains `<div class="game-footer"><span>...</span><button id="restart" disabled>...</button></div>`. The design says the leaderboard button is "appended into `.game-footer` (right side, beside the existing `restart` button)". Appending a button to `.game-footer` will place it after `#restart` in DOM order, which is correct for left-to-right flow. But the CSS uses `justify-content: space-between` on `.game-footer`, so a third flex child will be inserted between the existing two or pushed to the end without predictable visual placement. The design does not account for this layout impact.

**Concrete fix:** Specify the CSS change needed: e.g., wrap `#restart` and the new `#leaderboard-btn` in a `<div class="game-footer-right">` with `display:flex;gap:8px`, or explicitly state that the leaderboard button is appended as the last flex child and that the existing `justify-content:space-between` achieves the desired layout (left hint text, right-side buttons). Provide the CSS rule for `.game-footer-right` or confirm no wrapper is needed and explain why the layout will look correct.

---

**10. [MEDIUM] `bcryptjs.hashSync` with cost 12 in a synchronous single-threaded Node.js server blocks the event loop for ~200–400 ms per registration call. The design justifies this but does not document the impact on concurrent `/health` probe responses during that window**

Location: `auth.js` section, "cost 12; synchronous is fine since this is a low-volume endpoint."

With a `periodSeconds: 10` liveness probe, a single registration request can block the event loop long enough to cause one probe response to time out (default `timeoutSeconds: 1`). A missed probe does not immediately kill the pod, but under load (e.g., multiple simultaneous registrations during a burst) repeated probe failures will trigger a pod restart. The design dismisses this risk without quantifying it.

**Concrete fix:** Either lower the cost to 10 (matches NFR-1 minimum, ~80 ms at cost 10 on a modern CPU), or acknowledge the tradeoff explicitly with a note: "Cost 12 blocks the event loop for ~200–400 ms per call. With `periodSeconds: 10` and `failureThreshold: 3` (default), up to 3 concurrent registrations in 30 s would need to occur to cause a probe failure. Acceptable for a low-volume internal service." Add `failureThreshold: 3` to the liveness probe spec in `api-deployment.yaml` to make this explicit.

---

### NIT

**11. [NIT] The `package.json` lists `express: "4.18.3"` — as of mid-2024, Express 4.19.x patches a moderate open redirect vulnerability (CVE-2024-29041). Consider pinning to 4.19.2 or later**

Location: `package.json` section.

**Concrete fix:** Change `"express": "4.18.3"` to `"express": "4.19.2"` (or the latest 4.x patch at implementation time).

---

**12. [NIT] The design never specifies what `Auth.logout()` does besides `clearSession()` — in particular, whether it calls `renderAuthHeader()` to update the UI**

Location: `auth.js` module, `return` statement: `logout: clearSession`.

Calling `clearSession()` alone clears localStorage but does not update the DOM. The header will still show the username until page reload.

**Concrete fix:** `logout` should be a wrapper:
```js
function logout() { clearSession(); renderAuthHeader(); }
```
Expose `logout` instead of `clearSession` directly.

---

**13. [NIT] The deployment order is missing a `kubectl apply -f k8s/api-service.yaml` — the Service is embedded in `api-deployment.yaml` (multi-document YAML), which is fine, but the naming is inconsistent with the directory layout description that lists only `api-deployment.yaml`, `api-ingress.yaml`, and `api-pvc.yaml`**

Location: Kubernetes Manifests and Deployment Order sections.

The Service manifest is embedded in `api-deployment.yaml` as a second document separated by `---`. This works but is inconsistent with the separate-file pattern used by the desktop/mobile deployments (`deployment.yaml` contains Namespace + Deployment + Service for desktop, so it's the same pattern). No issue functionally, but the directory layout listed in the design shows only those three files, matching actual behaviour. No change needed — this is a documentation clarity note.

**Concrete fix:** Add a comment to the directory layout: `api-deployment.yaml # also contains the Service manifest (multi-doc YAML)`.

---

**14. [NIT] The `created_at` column in the leaderboard response uses `MIN(created_at)` — meaning the timestamp shown is the date of the user's *first* submission for that difficulty, not the date of their *best* score. This may confuse users**

Location: `leaderboard.js` SQL section.

**Concrete fix:** Change to `MAX(created_at)` (date of most recent attempt) or `(SELECT created_at FROM scores s2 WHERE s2.user_id = sub.user_id AND s2.difficulty = sub.difficulty AND s2.score = sub.best_score ORDER BY created_at DESC LIMIT 1)` to show when the best score was set. Or document the current `MIN` choice explicitly: "timestamp reflects when the user first played this difficulty, not when they set their best score."

---

**15. [NIT] `game-footer` button injection will re-enable the leaderboard button when difficulty buttons are re-enabled in `finish()` — the leaderboard button is not a `.difficulty-btn` and won't be affected, which is correct. But if `Auth.init()` is called multiple times (e.g., Play again reloads), the button and modal root divs would be injected a second time**

Location: "Changes to `game.js`" section.

`start()` does not call `Auth.init()`, and `Auth.init()` is only called once at IIFE bottom. This is safe. However, the design should explicitly state that `init()` is idempotent or that it guards against double-injection (`if (document.getElementById('auth-modal-root')) return`).

**Concrete fix:** Add: "`init()` guards against double-invocation: `if (document.getElementById('auth-modal-root')) return;` is the first line."

---

## Verified Assumptions

The following claims in the design were checked against the actual source and confirmed correct:

- **IIFE structure**: Both `game.js` and `mobile/game.js` are self-contained IIFEs. `finish()` is defined inside. `score` and `difficulty` are IIFE-local `let` variables accessible within `finish()`. ✓
- **CSS custom properties**: `style.css` and `mobile/style.css` both define `--coral`, `--lime`, `--ink`, `--muted`, `--cream`, `--sky`, `--field` in `:root`. ✓
- **Font stack**: Both files import `Fredoka One` and `Nunito` via Google Fonts. ✓
- **`localStorage` personal-best keys**: `game.js` uses `mole-meadow-best-${d}` (e.g., `mole-meadow-best-easy`). This matches FR-14 and the design. ✓
- **`.difficulty-btn` class**: Present in both CSS files; the design's filter pills adopting the same class is feasible. ✓
- **`#sound` button placement**: Confirmed as last element in `<header>` in both HTMLs. Auth button injection "next to the sound button" is structurally valid. ✓
- **`.game-footer` exists**: Present in both HTMLs. ✓
- **`#overlay` is `hidden` attribute-gated**: Both game files use `$('overlay').hidden = false/true`. The design's approach of toggling `.hidden` on the leaderboard panel is consistent. ✓
- **Tailscale ingress pattern**: `k8s/ingress.yaml` and `k8s/mobile-ingress.yaml` both use `ingressClassName: tailscale`, `defaultBackend.service.port.name: http`, `annotations: tailscale.com/funnel: "false"`, and `tls.hosts`. The design's `api-ingress.yaml` faithfully follows this pattern. ✓
- **K3d image import pattern**: The existing k8s manifests use `imagePullPolicy: Never`, confirming the `k3d image import` workflow. ✓
- **`whack-a-mole` namespace**: Confirmed in `deployment.yaml`. ✓
- **Existing Dockerfiles are single-stage nginx:alpine**: Confirmed. The design's updated `Dockerfile` and `Dockerfile.mobile` follow the same pattern. ✓
- **Mobile `game.js` adds `touchstart` listeners**: Confirmed. The mobile game.js has `touchstart` on hole buttons, confirming it is a separate file from desktop. ✓
- **`<dialog>` element not already present**: Neither `index.html` contains a `<dialog>` tag. The design's injection approach works. ✓

---

## Unverified / Wrong Assumptions

- **WRONG – "auth.js is at the repo root; mobile/auth.js is a copy"**: There is no `auth.js` in the repository today, and there is no `mobile/auth.js`. The design treats these as if they need to be created by the implementation agent, but the deployment steps and Dockerfiles reference these files without an explicit creation step. This overlaps with Finding 4.

- **UNVERIFIED – `better-sqlite3` 9.4.3 builds on `node:20-alpine` without extra tooling**: The design asserts this is true because the Dockerfile builds inside Alpine. However, `node:20-alpine` does not ship `python3`, `make`, or `g++`, which are required by `node-gyp`. This is WRONG — see Finding 2.

- **UNVERIFIED – "query is prepared once on module load" for leaderboard**: The design says the SQL query is prepared once. Because the filtered and unfiltered queries differ (one has a `WHERE` clause), two prepared statements are required. The design does not show how this is handled (two separate `db.prepare()` calls, or a dynamic approach). The implementation agent must resolve this.

- **UNVERIFIED – Tailscale tailnet domain is `tail18466c.ts.net`**: The CORS origin list and `API` constant in `auth.js` hardcode `https://whackamole.tail18466c.ts.net`. The requirements flag this assumption explicitly (Assumption 1) and state "if the actual tailnet domain differs, only the CORS list and the base URL need updating." The design inherits this assumption without adding a mechanism to configure it (no env var for `API_BASE_URL` in the frontend). For a static-file nginx container, the URL must be baked in at build time. This is acceptable but should be documented clearly.

- **WRONG (minor) – "Auth button is appended next to the sound button using the existing header layout"**: The header uses `justify-content: space-between` with three children: `.brand`, `.header-note`, and `.sound`. Appending a new button after `.sound` creates a 4th flex child. This won't break layout but will not be "next to" the sound button in the visual sense — it will appear after it, pushing past the right edge unless the header layout is adjusted. Finding 9 covers this for the game-footer; the same issue applies to the header.

---

## Verdict

HIGH findings: 4  
MEDIUM findings: 6  
Total blocking (HIGH + MEDIUM): 10

**CHANGES_REQUESTED**
