# PASS live dashboard (web)

A custom React dashboard for the PASS platform, fed by the wireless sensor nodes
over one WebSocket, and shareable as a single **public** link via a Cloudflare
tunnel. Replaces the old Streamlit UI.

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

## Files

- `backend/main.py` - UDP ingest (threads) + WebSocket fan-out + serves the app + `/api/layout`.
- `frontend/src/App.jsx` - dashboard: knee angle, hip tilt, feet pressure maps.
- `frontend/src/FeetMap.jsx` - SVG plantar-pressure maps from `feet/foot_layout.py`.
- `frontend/src/quat.js` - pelvis tilt-from-neutral math.
