r"""
PASS live dashboard - backend (data bridge).

Ingests sensor readings and serves them to browsers over one WebSocket, plus
the built React app. Two ways readings get in:

  - Direct UDP, when this runs on the same LAN as the sensor nodes:
      feet  -> UDP :5006   foot_left / foot_right : 16 pressure channels (inverted)
      knee  -> UDP :5005   knee_left / knee_right : seq,t_ms,angle,qthigh(4),qshank(4)
      hip   -> UDP :5004   hip,seq,t_ms,q(4)   pelvis quaternion
      actuation -> UDP :5007 (in) telemetry, :5008 (out) commands - see ingest.send_command
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

from . import ingest, sessions

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
    for port, kind in ((ingest.PORT_HIP, "hip"), (ingest.PORT_KNEE, "knee"), (ingest.PORT_FEET, "feet"),
                       (ingest.PORT_ACTUATION, "actuation")):
        threading.Thread(target=ingest._udp_listener, args=(port, kind), daemon=True).start()
    asyncio.create_task(_broadcaster())


async def _broadcaster() -> None:
    while True:
        if _clients:
            payload = ingest.snapshot()
            payload["actuationRecommendation"] = sessions.get_pending_recommendation()
            msg = json.dumps(payload)
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


@app.post("/api/actuation/command")
async def api_actuation_command(request: Request) -> dict:
    """Send a command to the actuation board. Always queues it for relay.py to
    drain and re-broadcast on the LAN (the path that matters when this backend
    is hosted remotely, e.g. Render), and also attempts a direct local
    broadcast (a no-op unless this process happens to be on the same LAN as
    the board) - so the same endpoint works whether running locally or not."""
    body = await request.json()
    cmd = body.get("cmd")
    value = float(body.get("value", 0))
    if not cmd:
        raise HTTPException(status_code=400, detail="missing 'cmd'")
    ingest.send_command(cmd, value)
    ingest.queue_command(cmd, value)
    return {"ok": True, "cmd": cmd, "value": value}


@app.get("/api/actuation/pending")
async def api_actuation_pending(request: Request) -> dict:
    """Polled by relay.py to fetch commands queued via /api/actuation/command
    that still need forwarding to the LAN-local board. Gated by the same
    RELAY_KEY as /api/ingest - only a relay bridging this backend to a real
    LAN should be draining this."""
    if not RELAY_KEY or request.headers.get("x-relay-key") != RELAY_KEY:
        raise HTTPException(status_code=403, detail="bad or missing relay key")
    return {"commands": ingest.drain_commands()}


@app.post("/api/actuation/session")
async def api_actuation_session(request: Request) -> dict:
    """Log one finished session (ActuationPanel.jsx calls this from both a
    normal Stop and a mid-exercise Force Stop) and recompute the next-weight
    recommendation from it. kgOptions comes from the request rather than
    being hardcoded here, so the preset list has one source of truth (the
    frontend's KG_OPTIONS) instead of two copies that can drift apart."""
    body = await request.json()
    try:
        record = sessions.log_session(
            target_kg=float(body["target"]), duration_s=float(body["durationS"]),
            peak_kg=float(body["peak"]), avg_kg=float(body["avg"]),
            samples=int(body["samples"]), completed=bool(body["completed"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"bad session payload: {exc}")
    kg_options = body.get("kgOptions") or []
    recommendation = sessions.refresh_recommendation(kg_options) if kg_options else None
    return {"session": record, "recommendation": recommendation}


@app.get("/api/actuation/sessions")
async def api_actuation_sessions(limit: int = 50) -> dict:
    return {"sessions": sessions.get_sessions(limit=limit)}


@app.post("/api/actuation/recommendation/respond")
async def api_actuation_recommendation_respond(request: Request) -> dict:
    """Clinician approves or rejects the pending recommendation. The result
    is picked up by every connected client (patient included) on the next
    broadcast tick via actuationRecommendation in the live snapshot - no
    separate patient-notification channel needed."""
    body = await request.json()
    approved = bool(body.get("approved"))
    result = sessions.respond_to_recommendation(approved)
    if result is None:
        raise HTTPException(status_code=409, detail="no recommendation is currently pending")
    return {"recommendation": result}


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
