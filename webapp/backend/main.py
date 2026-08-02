r"""
PASS live dashboard - backend (data bridge).

Ingests the wireless sensor UDP streams and serves them to browsers over one
WebSocket, plus the built React app. A cloudflared tunnel in front of this makes
it a single public https link.

    feet  -> UDP :5006   foot_left / foot_right : 16 pressure channels (inverted)
    knee  -> UDP :5005   seq,t_ms,angle,qthigh(4),qshank(4)
    hip   -> UDP :5004   hip,seq,t_ms,q(4)   pelvis quaternion

UDP is received on plain sockets in daemon threads (robust on Windows, where
asyncio datagram endpoints are unreliable); FastAPI/asyncio only reads the shared
snapshot and fans it out to WebSocket clients at ~20 Hz.

Run (from repo root, venv):
    ..\.venv\Scripts\python -m uvicorn webapp.backend.main:app --host 0.0.0.0 --port 8000
Then tunnel it public:
    cloudflared tunnel --url http://localhost:8000
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import socket
import sys
import threading
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

# --- node ports ---
PORT_FEET = 5006
PORT_KNEE = 5005
PORT_HIP = 5004

REPO = pathlib.Path(__file__).resolve().parents[2]
FRONTEND_DIST = REPO / "webapp" / "frontend" / "dist"

# --- shared latest state (updated by UDP threads, read by the broadcaster) ---
STATE = {
    "hip":  {"q": [1.0, 0, 0, 0], "t_ms": 0},
    "knee": {"angle": 0.0, "q_thigh": [1.0, 0, 0, 0], "q_shank": [1.0, 0, 0, 0], "t_ms": 0},
    "feet": {"left":  {"c": [0] * 16, "t_ms": 0},
             "right": {"c": [0] * 16, "t_ms": 0}},
}
_last: dict[str, float] = {}   # key -> monotonic time of last packet


def _mark(key: str) -> None:
    _last[key] = time.monotonic()


def _handle_line(kind: str, line: str) -> None:
    parts = line.strip().split(",")
    if len(parts) < 3:
        return
    try:
        if kind == "hip" and parts[0] == "hip" and len(parts) >= 7:
            STATE["hip"]["t_ms"] = int(float(parts[2]))
            STATE["hip"]["q"] = [float(v) for v in parts[3:7]]
            _mark("hip")
        elif kind == "knee" and parts[0].lstrip("-").isdigit() and len(parts) >= 11:
            STATE["knee"]["t_ms"] = int(float(parts[1]))
            STATE["knee"]["angle"] = float(parts[2])
            STATE["knee"]["q_thigh"] = [float(v) for v in parts[3:7]]
            STATE["knee"]["q_shank"] = [float(v) for v in parts[7:11]]
            _mark("knee")
        elif kind == "feet" and parts[0] in ("foot_left", "foot_right") and len(parts) >= 19:
            side = "left" if parts[0] == "foot_left" else "right"
            STATE["feet"][side]["t_ms"] = int(float(parts[2]))
            STATE["feet"][side]["c"] = [int(float(v)) for v in parts[3:19]]
            _mark("foot_" + side)
    except ValueError:
        return


def _udp_listener(port: int, kind: str) -> None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("0.0.0.0", port))
    except OSError as exc:
        print(f"# UDP {port} ({kind}) bind failed: {exc}")
        return
    print(f"# listening for {kind} on UDP :{port}")
    while True:
        try:
            data, _addr = s.recvfrom(2048)
        except OSError:
            continue
        for line in data.decode("ascii", "ignore").splitlines():
            _handle_line(kind, line)


def _snapshot() -> dict:
    now = time.monotonic()

    def age(key):
        t = _last.get(key)
        return None if t is None else round(now - t, 2)

    return {
        "t": round(now, 3),
        "hip":  {**STATE["hip"], "age": age("hip")},
        "knee": {**STATE["knee"], "age": age("knee")},
        "feet": {"left":  {**STATE["feet"]["left"],  "age": age("foot_left")},
                 "right": {**STATE["feet"]["right"], "age": age("foot_right")}},
    }


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
    for port, kind in ((PORT_HIP, "hip"), (PORT_KNEE, "knee"), (PORT_FEET, "feet")):
        threading.Thread(target=_udp_listener, args=(port, kind), daemon=True).start()
    asyncio.create_task(_broadcaster())


async def _broadcaster() -> None:
    while True:
        if _clients:
            msg = json.dumps(_snapshot())
            for ws in list(_clients):
                try:
                    await ws.send_text(msg)
                except Exception:
                    _clients.discard(ws)
        await asyncio.sleep(0.05)   # 20 Hz


@app.get("/api/layout")
def api_layout() -> dict:
    return _foot_layout()


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
