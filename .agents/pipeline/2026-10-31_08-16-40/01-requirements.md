# Requirements: Authentication System, Score Saving, and Top-10 Leaderboard

## Summary

Add user authentication and a global leaderboard to Mole Meadow. Players may optionally register and log in; when logged in, scores are automatically saved to a backend API after each round. A top-10 leaderboard panel (global and per-difficulty) is accessible from both the desktop and mobile frontends. The backend runs as a containerised Node.js/Express service in the existing `whack-a-mole` K3d namespace, exposed at `whackamoleapi` via Tailscale ingress, with data persisted to a SQLite file on a Kubernetes PersistentVolumeClaim. The existing personal-best localStorage behaviour is unchanged.

---

## Functional Requirements

### Backend API service

**FR-1 – User registration**
The API must accept a `POST /auth/register` request with a `username` and `password`. It must create a new user account, store the username and bcrypt-hashed password in the database, and return a signed JWT on success. Attempting to register a username that already exists must return an error without creating a duplicate.

**FR-2 – User login**
The API must accept a `POST /auth/login` request with `username` and `password`. It must verify the credentials against the stored bcrypt hash and return a signed JWT on success. Invalid credentials must return a 401 response.

**FR-3 – Score submission**
The API must accept a `POST /scores` request containing `score` (integer) and `difficulty` (`easy`, `medium`, or `hard`), authenticated via a JWT Bearer token in the `Authorization` header. It must store the score linked to the authenticated user and return the saved record.

**FR-4 – Global top-10 leaderboard**
The API must accept a `GET /leaderboard` request. It must return the top 10 scores across all users and difficulties, ordered by score descending. Each entry must include: rank, username, score, difficulty, and timestamp.

**FR-5 – Per-difficulty top-10 leaderboard**
The API must accept a `GET /leaderboard?difficulty=<easy|medium|hard>` query parameter to filter the top-10 results to a single difficulty level.

**FR-6 – Health endpoint**
The API must expose a `GET /health` endpoint that returns HTTP 200 with a JSON body for liveness/readiness probes.

**FR-7 – Persistent storage**
User accounts and scores must be stored in a SQLite database file mounted from a Kubernetes PersistentVolumeClaim (ReadWriteOnce, minimum 256Mi). Data must survive pod restarts and redeployments.

**FR-8 – Containerisation and deployment**
The backend must be packaged as a Docker image (no external registry; imported into K3d cluster `hercules` with `k3d image import`). A Kubernetes Deployment, Service, and Tailscale Ingress must be added to `k8s/` for the new service, deployed to the `whack-a-mole` namespace. The Tailscale hostname must be `whackamoleapi` (no dashes or underscores).

### Desktop frontend (`index.html`, `game.js`, `style.css`)

**FR-9 – Auth UI**
A login/register modal or overlay must be accessible via a "Log in" button in the page header. The modal must contain a username field, a password field, and buttons to either log in or switch to a register form. Closing the modal without logging in must leave the player in guest mode — the game remains fully playable.

**FR-10 – Session persistence**
On successful login or registration the JWT must be stored in `localStorage` and reused on subsequent page loads so the player does not need to log in every visit. A "Log out" action must clear the token and return to guest mode.

**FR-11 – Authenticated score saving**
When a round ends and the player is logged in, `game.js` must automatically `POST /scores` with the round's score and difficulty. This must be fire-and-forget: a network failure must not block the end-of-round overlay or break gameplay.

**FR-12 – Leaderboard panel**
A leaderboard button near the scoreboard must open a panel showing the top-10 global scores (name, score, difficulty). The panel must support filtering by difficulty. It must refresh automatically after each round ends.

**FR-13 – Logged-in state indicator**
When logged in, the header must display the player's username and a "Log out" button in place of the "Log in" button.

**FR-14 – Personal-best preservation**
The existing `localStorage` personal-best logic (keys `mole-meadow-best-easy`, `mole-meadow-best-medium`, `mole-meadow-best-hard`) must remain in place and continue working identically for all players, logged in or not.

### Mobile frontend (`mobile/index.html`, `mobile/game.js`, `mobile/style.css`)

**FR-15 – Feature parity with desktop**
The mobile frontend must implement all of FR-9 through FR-14. UI components (modal, leaderboard panel) must be touch-friendly and fit within a single-column mobile layout.

---

## Non-Functional Requirements

**NFR-1 – Security**
Passwords must be hashed with bcrypt (minimum cost factor 10). JWTs must be signed with a secret loaded from an environment variable (not hard-coded). Tokens must expire after 7 days. The API must validate and sanitise all inputs before touching the database; SQL must be parameterised. CORS must be restricted to the two known frontend origins (`whackamole.tail18466c.ts.net` and `whackamolemobile.tail18466c.ts.net`).

**NFR-2 – Performance**
Leaderboard queries must complete in under 200 ms under normal single-node K3d load. Score submission must not add measurable latency to the end-of-round screen (it is async and non-blocking).

**NFR-3 – Reliability**
The API deployment must have a liveness probe on `GET /health` and a readiness probe on the same endpoint. A single replica is acceptable for this internal-only service.

**NFR-4 – Backwards compatibility**
Guest mode (not logged in) must be fully functional. No existing frontend behaviour may regress for unauthenticated users.

**NFR-5 – Hostname convention**
The Tailscale ingress hostname must contain no dashes or underscores: `whackamoleapi`.

---

## Acceptance Criteria

**AC-1** A new user can register with a unique username and password via `POST /auth/register` and receive a JWT in the response.

**AC-2** Attempting to register with a username that already exists returns an HTTP 409 error and no duplicate record is created.

**AC-3** A registered user can log in via `POST /auth/login` and receive a valid JWT. Submitting wrong credentials returns HTTP 401.

**AC-4** An authenticated `POST /scores` saves the score and returns the saved record. An unauthenticated request returns HTTP 401.

**AC-5** `GET /leaderboard` returns exactly 10 entries (or fewer if fewer scores exist), ordered by score descending, each with `rank`, `username`, `score`, `difficulty`, and `timestamp`.

**AC-6** `GET /leaderboard?difficulty=hard` returns only entries where difficulty is `hard`.

**AC-7** `GET /health` returns HTTP 200 with a JSON body at all times when the pod is healthy.

**AC-8** The SQLite database file survives a pod deletion and restart: scores and users recorded before the restart are still present afterwards.

**AC-9** Both the desktop and mobile frontends display a "Log in" button. Clicking it opens the login/register UI without breaking or interrupting an in-progress game.

**AC-10** After successful login the header shows the player's username and a "Log out" button. After logging out the header reverts to "Log in".

**AC-11** After a round ends while logged in, the score is automatically posted to the API with the correct difficulty. If the API call fails, the end-of-round overlay still appears normally.

**AC-12** The leaderboard panel opens and displays top-10 entries from the API. It refreshes after each round completes.

**AC-13** The personal-best display (`#best`) continues to load from and save to `localStorage` identically to the pre-feature behaviour, regardless of login state.

**AC-14** The API pod is Running in the `whack-a-mole` namespace and the Tailscale ingress for `whackamoleapi` has an address assigned.

**AC-15** The desktop and mobile Tailscale ingresses (`whackamole`, `whackamolemobile`) continue to serve the updated frontends without disruption.

---

## Out of Scope

- Password reset or email-based account recovery
- OAuth / social login (Google, GitHub, etc.)
- Per-user score history pages or detailed stats
- Admin UI for moderating users or scores
- Rate limiting or anti-cheat / score validation on the server
- Public internet exposure via Tailscale Funnel (the service remains internal-network only)
- Automated CI/CD pipeline changes
- PostgreSQL or Redis (SQLite on a PVC satisfies the persistence requirement at this scale)

---

## Assumptions

1. **API origin**: The frontend will call the API using the Tailscale HTTPS address `https://whackamoleapi.tail18466c.ts.net`. If the actual Tailscale tailnet domain differs, only the CORS origin list and the hardcoded API base URL in `game.js` need updating.
2. **Single replica for the API**: Because SQLite is used (one writer), the API Deployment runs 1 replica. If horizontal scaling is later needed, the database choice would need revisiting.
3. **JWT secret provisioning**: A Kubernetes Secret named `whackamoleapi-jwt-secret` will be created manually before deployment; the design phase will specify the exact secret key name.
4. **No HTTPS termination at the app layer**: TLS is handled by the Tailscale ingress operator, so the Express server listens on plain HTTP internally.
5. **Score board shows all-time best per user**: The leaderboard returns the single highest score per user-difficulty combination, not every submission. *(To be confirmed in design; if raw submission log is preferred instead, the schema changes slightly.)*
6. **Username constraints**: Usernames are 3–30 characters, alphanumeric plus underscores, case-insensitive for uniqueness checks. This will be enforced by the API.
