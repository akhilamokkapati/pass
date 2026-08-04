# PASS live dashboard (web)

A custom React dashboard for the PASS platform, fed by the wireless sensor nodes
over one WebSocket. Replaces the old Streamlit UI.

Two ways to make it public:
- **Cloudflare quick tunnel** (below) - instant, but temporary: dies when your
  laptop/process stops, new random URL every time.
- **Render** (below) - a permanent URL that stays up with nothing running on
  your laptop. Live sensor data needs `relay.py` running locally too - see
  "Live data on a remote deploy".

```
sensors --UDP--> FastAPI (backend) --serves--> React app + live WebSocket
   feet :5006        webapp/backend/main.py         webapp/frontend
   knee :5005                                              |
   hip  :5004                  cloudflared tunnel --> ONE public https URL
```

## One-time setup

Node is installed but its bundled **npm is broken** (winget glitch), so we use
**pnpm via corepack** and call Vite directly.

```bash
# from webapp/frontend
corepack pnpm install
```

## Build the frontend (after any frontend change)

```bash
# from webapp/frontend  (pnpm's build wrapper is flaky, call vite directly)
node node_modules/vite/bin/vite.js build
```

This writes `webapp/frontend/dist/`, which the backend serves automatically.

## Run the backend (serves the built app + ingests the sensors)

```bash
# from repo root, in the venv
../.venv/Scripts/python -m uvicorn webapp.backend.main:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000 . Any node powered on the same network shows up live;
missing nodes show "offline" and dim.

## Make the link public (any phone, anywhere)

In a second terminal:

```bash
cloudflared tunnel --url http://localhost:8000
```

It prints a `https://<random>.trycloudflare.com` URL (make a QR of it). That URL
serves the app AND the WebSocket, so phones on cellular see live data.

Note: for a public link with REAL sensors, the laptop must be on the sensor
network (30.007) AND have internet at once - give it internet over Ethernet while
WiFi stays on 30.007, or configure the travel router to share internet.

## Dev mode (optional, hot reload)

```bash
# terminal 1: backend (as above)
# terminal 2, from webapp/frontend:
node node_modules/vite/bin/vite.js       # opens :5173, proxies /ws + /api to :8000
```

## Permanent public hosting (Render)

`Dockerfile` + `render.yaml` at the repo root build the frontend and run the
same backend as a proper cloud web service - no laptop involved, URL never
changes.

1. Sign up at [render.com](https://render.com) (GitHub login, no card needed
   for the free plan).
2. **New -> Blueprint**, connect the `pass` repo. Render reads `render.yaml`
   and configures the `pass-dashboard` service automatically - click Apply.
3. You get a permanent `https://pass-dashboard.onrender.com`-style URL.

Free plan sleeps after 15 min with no visitors; next visitor waits ~30-50s for
it to wake. Upgrading the Render plan removes that if it matters later.

Without anything else running, this URL shows the same honest "no sensors
connected" state as running locally with no hardware - see below to make it
show live data.

## Live data on a remote deploy

A cloud host isn't on your LAN, so it can't hear the sensor nodes' UDP
broadcasts directly. `webapp/relay.py` bridges this: run it on any machine on
the sensor network (your laptop) and it forwards live readings to the remote
backend over HTTPS. No firmware changes - nodes keep broadcasting UDP exactly
as before.

**One-time setup on Render:** in the service's Environment tab, add
`RELAY_KEY` set to a random secret (e.g. `python -c "import secrets;
print(secrets.token_hex(24))"`). Leaving it unset disables the ingest endpoint
entirely (LAN-direct UDP is unaffected either way).

**Run the relay** (from repo root, venv, on a machine on the sensor network):

```bash
../.venv/Scripts/python -m webapp.relay --url https://pass-dashboard.onrender.com --key <RELAY_KEY>
```

Or via env vars: `set PASS_RELAY_URL=...` and `set RELAY_KEY=...`, then
`../.venv/Scripts/python -m webapp.relay`.

Only run this while you actually have hardware on and want it visible on the
public link - stop it (Ctrl+C) any time and the remote dashboard just goes
back to "no sensors connected" once readings age out (1.5s), same as always.

## Files

- `backend/ingest.py` - shared sensor-state: UDP parsing, live STATE, snapshot/age logic. Used by both `main.py` (direct LAN UDP) and `relay.py` (remote push).
- `backend/main.py` - WebSocket fan-out + serves the app + `/api/layout` + `/api/ingest` (relay endpoint).
- `relay.py` - forwards local UDP sensor data to a remotely-hosted backend over HTTPS.
- `frontend/src/App.jsx` - dashboard: knee angle, hip tilt, feet pressure maps.
- `frontend/src/FeetMap.jsx` - SVG plantar-pressure maps from `feet/foot_layout.py`.
- `frontend/src/quat.js` - pelvis tilt-from-neutral math.
