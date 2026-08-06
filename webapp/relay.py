r"""
PASS live dashboard - relay.

Run this on a machine that's on the same LAN as the sensor nodes (feet/knee/hip
XIAO ESP32s), whenever you want a REMOTELY-hosted dashboard (e.g. the Render
deploy) to show live data instead of "no sensors connected".

It listens for the exact same UDP broadcasts the local backend listens for,
and POSTs a compact snapshot to the remote backend's /api/ingest every 0.2s
(5 Hz - plenty fast against the frontend's 1.5s staleness threshold).

The remote backend fans it out to browsers over its own WebSocket exactly like
it does for local UDP - nothing about the frontend changes.

Usage (from repo root, venv):
    ..\.venv\Scripts\python -m webapp.relay --url https://pass-dashboard.onrender.com --key <RELAY_KEY>

Or set env vars instead of flags:
    set PASS_RELAY_URL=https://pass-dashboard.onrender.com
    set RELAY_KEY=<same key configured on Render>
    ..\.venv\Scripts\python -m webapp.relay

Stop it any time (Ctrl+C) - the remote dashboard just goes back to showing
"no sensors connected" once readings age past 1.5s, same as it always has.
"""

from __future__ import annotations

import argparse
import json
import os
import threading
import time
import urllib.error
import urllib.request

from .backend import ingest

STALE_S = 3.0          # only forward a part if it's this fresh locally - widened
                        # to match the frontend's own widened threshold (see
                        # useMetrics.js): a brief local UDP gap shouldn't drop
                        # a node out of the payload and start its Render-side
                        # age climbing for no reason
PUSH_INTERVAL_S = 0.2  # 5 Hz
CMD_POLL_INTERVAL_S = 0.3


def _fresh_parts() -> dict:
    """Build the subset of the snapshot that's actually live right now."""
    snap = ingest.snapshot()
    out: dict = {}
    if snap["hip"]["age"] is not None and snap["hip"]["age"] < STALE_S:
        out["hip"] = snap["hip"]
    knee: dict = {}
    if snap["knee"]["left"]["age"] is not None and snap["knee"]["left"]["age"] < STALE_S:
        knee["left"] = snap["knee"]["left"]
    if snap["knee"]["right"]["age"] is not None and snap["knee"]["right"]["age"] < STALE_S:
        knee["right"] = snap["knee"]["right"]
    if knee:
        out["knee"] = knee
    feet: dict = {}
    if snap["feet"]["left"]["age"] is not None and snap["feet"]["left"]["age"] < STALE_S:
        feet["left"] = snap["feet"]["left"]
    if snap["feet"]["right"]["age"] is not None and snap["feet"]["right"]["age"] < STALE_S:
        feet["right"] = snap["feet"]["right"]
    if feet:
        out["feet"] = feet
    if snap["actuation"]["age"] is not None and snap["actuation"]["age"] < STALE_S:
        out["actuation"] = snap["actuation"]
    return out


def _push_loop(url: str, key: str) -> None:
    endpoint = url.rstrip("/") + "/api/ingest"
    ok_streak = 0
    while True:
        payload = _fresh_parts()
        if payload:
            body = json.dumps(payload).encode()
            req = urllib.request.Request(
                endpoint, data=body, method="POST",
                headers={"Content-Type": "application/json", "X-Relay-Key": key},
            )
            try:
                with urllib.request.urlopen(req, timeout=3) as resp:
                    resp.read()
                ok_streak += 1
                if ok_streak == 1:
                    print(f"# relay: connected, forwarding to {endpoint}")
            except urllib.error.HTTPError as exc:
                ok_streak = 0
                print(f"# relay: rejected ({exc.code}) - check RELAY_KEY matches on both sides")
            except Exception as exc:  # network hiccup, cold-start wake-up, etc.
                ok_streak = 0
                print(f"# relay: push failed ({exc}), retrying")
        time.sleep(PUSH_INTERVAL_S)


def _cmd_poll_loop(url: str, key: str) -> None:
    """Drain commands queued on the remote backend (dashboard buttons calling
    /api/actuation/command) and re-broadcast each on the LAN so it actually
    reaches the board - mirrors _push_loop but in the opposite direction."""
    endpoint = url.rstrip("/") + "/api/actuation/pending"
    while True:
        req = urllib.request.Request(endpoint, method="GET", headers={"X-Relay-Key": key})
        try:
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read())
            for c in data.get("commands", []):
                ingest.send_command(c["cmd"], c.get("value", 0.0))
                print(f"# relay: forwarded command {c['cmd']}={c.get('value', 0.0)} to board")
        except Exception:
            pass  # network hiccup, cold-start wake-up, etc. - next poll catches up
        time.sleep(CMD_POLL_INTERVAL_S)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default=os.environ.get("PASS_RELAY_URL"),
                     help="Remote dashboard base URL, e.g. https://pass-dashboard.onrender.com")
    ap.add_argument("--key", default=os.environ.get("RELAY_KEY"),
                     help="Must match RELAY_KEY set in the Render service's environment")
    args = ap.parse_args()

    if not args.url or not args.key:
        raise SystemExit("Need --url and --key (or PASS_RELAY_URL / RELAY_KEY env vars)")

    for port, kind in ((ingest.PORT_HIP, "hip"), (ingest.PORT_KNEE, "knee"), (ingest.PORT_FEET, "feet"),
                       (ingest.PORT_ACTUATION, "actuation")):
        threading.Thread(target=ingest._udp_listener, args=(port, kind), daemon=True).start()

    threading.Thread(target=_cmd_poll_loop, args=(args.url, args.key), daemon=True).start()

    print(f"# relay: listening for hip/knee/feet/actuation UDP, pushing live parts to {args.url}")
    _push_loop(args.url, args.key)


if __name__ == "__main__":
    main()
