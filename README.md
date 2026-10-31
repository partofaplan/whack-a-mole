# Mole Meadow

A responsive, dependency-free whack-a-mole web game. Click or tap the furry moles in a 30-second round. Consecutive quick hits unlock up to a 3× scoring multiplier. Personal bests are stored locally; synthesized sound is optional.

## Run

From this directory:

```sh
python3 -m http.server 3000 --bind 0.0.0.0
```

Open the server in a browser. No build, package installation, credentials, or backend services are required. Google Fonts is optional; system font fallbacks work offline.

## Controls

Use the mouse, touchscreen, or keyboard (Tab to a hole and Enter/Space to whack). Start over restarts the timer and score. Sound is off by default.
