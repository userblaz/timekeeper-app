# Timekeeper

A web app for tracking mechanical watch/clock accuracy over time, plus an experimental mic-based timegrapher for estimating beat rate and drift from tick sound.

Live version: https://geegee.si/timekeeper/

## Current state

- Single `index.html` file — vanilla JS/CSS, no build step, no backend.
- Data (watches, readings) is stored in the browser's `localStorage`, per device. Export/Import JSON buttons exist for manual backup/transfer.
- The Timegrapher tab uses `getUserMedia` + Web Audio API to detect ticks from the mic and estimate rate/beat error. Marked experimental — amplitude in degrees isn't shown, since that needs a calibrated contact mic.

### Known limitation
On iOS Safari, the OS applies mic gain compression (AGC) that can't be disabled from JavaScript, regardless of the `autoGainControl:false` constraint in the code. This affects timegrapher accuracy on iPhone specifically. Not a bug — a platform limit. See roadmap below.

## Roadmap

1. **Restructure** into separate HTML/CSS/JS + Vite build, still a static site.
2. **Multi-user backend** via Supabase (Postgres + Auth) — each user gets a private account with their own watches/readings, replacing localStorage-only storage.
3. **Isolate the audio-capture module** behind a clean interface, so it can be swapped for native audio later without touching the rest of the app.
4. **Native wrapper** via Capacitor once the web app is solid, to fix the iOS mic limitation and enable App Store/Play Store distribution.

## Workflow

- `main` is always deployable — don't commit broken code directly to it.
- Create a branch per change, open a pull request, get it reviewed before merging.
- On GitHub's web UI: edit a file → choose "Create a new branch for this commit and start a pull request" instead of committing straight to main.
- Once merged to `main`, [deploy method — e.g. Netlify auto-deploy] pushes it live automatically.

## Running locally

Currently just a static file — open `index.html` directly in a browser, or serve it with any static file server. (Will update once Vite is added.)
