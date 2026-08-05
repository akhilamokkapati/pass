r"""
PASS live dashboard - backend (data bridge).

Ingests sensor readings and serves them to browsers over one WebSocket, plus
the built React app. Two ways readings get in:

  - Direct UDP, when this runs on the same LAN as the sensor nodes:
      feet  -> UDP :5006   foot_left / foot_right : 16 pressure channels (inverted)
      knee  -> UDP :5005   knee_left / knee_right : seq,t_ms,angle,qthigh(4),qshank(4)
      hip   -> UDP :5004   hip,seq,t_ms,q(4)   pelvis quaternion
  - POST /api/ingest, from relay.py, when this runs remotely (e.g. Render) and
    a relay on the LAN forwards readings over HTTPS instead.

UDP is received on plain sockets in daemon threads (robust on Windows, where
asyncio datagram endpoints are unreliable); FastAPI/asyncio only reads the shared
snapshot and fans it out to WebSocket clients at ~20 Hz.

Run locally (from repo root, venv):
    ..\.venv\Scripts\python -m uvicorn webapp.backend.main:app --host 0.0.0.0 --port 8000
Then tunnel it public:
    cloudflared tunnel --url http://localhost:8000
Or deploy permanently: see render.yaml + webapp/README.md.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sys
import threading

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from . import ingest

REPO = pathlib.Path(__file__).resolve().parents[2]
FRONTEND_DIST = REPO / "webapp" / "frontend" / "dist"

# Shared secret relay.py must present to POST /api/ingest. Unset on Render ->
# ingest endpoint stays disabled (LAN-direct UDP still works either way).
RELAY_KEY = os.environ.get("RELAY_KEY")


def _foot_layout() -> dict:
    """Zone positions for drawing the feet, read from feet/foot_layout.py."""
    sys.path.insert(0, str(REPO / "feet"))
    from foot_layout import LEFT_POSITIONS, RIGHT_POSITIONS, LEFT_ANATOMY, RIGHT_ANATOMY

    def pack(pos, anat):
        return {str(c): {"x": xy[0], "y": xy[1], "anatomy": anat.get(c)}
                for c, xy in pos.items()}
    return {"left": pack(LEFT_POSITIONS, LEFT_ANATOMY),
            "right": pack(RIGHT_POSITIONS, RIGHT_ANATOMY)}


app = FastAPI(title="PASS live dashboard")
_clients: set[WebSocket] = set()


@app.on_event("startup")
async def _startup() -> None:
    for port, kind in ((ingest.PORT_HIP, "hip"), (ingest.PORT_KNEE, "knee"), (ingest.PORT_FEET, "feet")):
        threading.Thread(target=ingest._udp_listener, args=(port, kind), daemon=True).start()
    asyncio.create_task(_broadcaster())


async def _broadcaster() -> None:
    while True:
        if _clients:
            msg = json.dumps(ingest.snapshot())
            for ws in list(_clients):
                try:
                    await ws.send_text(msg)
                except Exception:
                    _clients.discard(ws)
        await asyncio.sleep(0.05)   # 20 Hz


@app.get("/api/layout")
def api_layout() -> dict:
    return _foot_layout()


@app.post("/api/ingest")
async def api_ingest(request: Request) -> dict:
    """Receives snapshots forwarded by relay.py when this backend is hosted
    remotely and can't hear the sensor nodes' local UDP broadcast directly."""
    if not RELAY_KEY or request.headers.get("x-relay-key") != RELAY_KEY:
        raise HTTPException(status_code=403, detail="bad or missing relay key")
    payload = await request.json()
    ingest.apply_remote_snapshot(payload)
    return {"ok": True}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    _clients.add(ws)
    try:
        while True:
            await ws.receive_text()      # ignore client messages; keepalive only
    except (WebSocketDisconnect, Exception):
        _clients.discard(ws)


# Serve the built React app if present; otherwise a built-in test page so the
# pipeline can be verified before the frontend is built.
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
else:
    @app.get("/", response_class=HTMLResponse)
    def _test_page() -> str:
        return """<!doctype html><meta charset=utf-8>
<title>PASS backend - live test</title>
<body style="font:14px system-ui;background:#111;color:#eee;padding:20px">
<h2>PASS backend live test</h2>
<p>Raw WebSocket snapshot (20 Hz). Build the React app to replace this.</p>
<pre id=out style="white-space:pre-wrap;color:#8f8"></pre>
<script>
const out=document.getElementById('out');
const ws=new WebSocket(`ws://${location.host}/ws`);
ws.onmessage=e=>{out.textContent=JSON.stringify(JSON.parse(e.data),null,2)};
ws.onopen=()=>ws.send('hi');
ws.onclose=()=>out.textContent='(socket closed)';
</script>"""
