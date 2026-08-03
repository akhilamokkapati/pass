# battery_monitor.py - live battery levels for the PASS feet over WiFi.
# Run:  ../.venv/Scripts/python battery_monitor.py   then open  http://localhost:8080
# Needs the feet flashed with the battery firmware (sends foot_x,...,c0..c15,batt).
# Standalone (standard library only); the full dashboard shows the same in its
# Devices panel. Run only ONE listener on UDP 5006 at a time.
import socket, threading, time, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UDP_PORT = 5006
HTTP_PORT = 8080
state, lock = {}, threading.Lock()


def udp_listener():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", UDP_PORT))
    print(f"listening for feet on UDP :{UDP_PORT}")
    while True:
        data, _ = s.recvfrom(2048)
        for line in data.decode("ascii", "ignore").splitlines():
            p = line.strip().split(",")
            # foot_left/right, frame, t_ms, c0..c15, batt  -> 20 fields
            if len(p) >= 20 and p[0] in ("foot_left", "foot_right"):
                try:
                    batt = int(float(p[19]))
                except ValueError:
                    continue
                with lock:
                    state[p[0]] = {"batt": batt, "t": time.monotonic()}


PAGE = """<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>PASS feet battery</title>
<style>
body{margin:0;background:radial-gradient(900px 500px at 50% -10%,#16233a,#0e1116 60%);color:#eef2f7;
font:16px system-ui;display:flex;flex-direction:column;align-items:center;padding:36px}
h1{font-weight:800;letter-spacing:1px}.feet{display:flex;gap:24px;flex-wrap:wrap;justify-content:center}
.card{background:#171b22;border:1px solid #2a313c;border-radius:18px;padding:24px 28px;width:220px;text-align:center}
.name{color:#8b96a5;font-size:14px;text-transform:capitalize}
.batt{width:130px;height:52px;border:3px solid #8b96a5;border-radius:9px;margin:14px auto;padding:4px;position:relative}
.batt::after{content:"";position:absolute;right:-10px;top:16px;width:6px;height:16px;background:#8b96a5;border-radius:0 2px 2px 0}
.fill{height:100%;border-radius:3px;width:0;transition:width .4s,background .4s}
.pct{font-size:40px;font-weight:800;margin-top:6px}.state{color:#8b96a5;font-size:13px;margin-top:4px}
.off .pct{color:#5a6472}
</style>
<h1>PASS feet &middot; battery</h1>
<div class=feet>
 <div class=card id=foot_left><div class=name>left foot</div><div class=batt><div class=fill></div></div><div class=pct>--</div><div class=state>waiting...</div></div>
 <div class=card id=foot_right><div class=name>right foot</div><div class=batt><div class=fill></div></div><div class=pct>--</div><div class=state>waiting...</div></div>
</div>
<script>
const col=p=>p<=15?'#ff5a4d':p<=35?'#f6c24b':'#3ddc84';
async function tick(){let d={};try{d=await(await fetch('/data')).json()}catch(e){}
 for(const u of ['foot_left','foot_right']){const el=document.getElementById(u),v=d[u],live=v&&v.age<4;
  el.classList.toggle('off',!live);const pct=el.querySelector('.pct'),fill=el.querySelector('.fill'),st=el.querySelector('.state');
  if(live){pct.textContent=v.batt+'%';fill.style.width=v.batt+'%';fill.style.background=col(v.batt);st.textContent='live';}
  else{pct.textContent='--';fill.style.width='0';st.textContent=v?'stale':'not connected';}}}
setInterval(tick,1500);tick();
</script>"""


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/data"):
            now = time.monotonic()
            with lock:
                out = {u: {"batt": v["batt"], "age": round(now - v["t"], 1)} for u, v in state.items()}
            body = json.dumps(out).encode()
            ctype = "application/json"
        else:
            body, ctype = PAGE.encode(), "text/html"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    threading.Thread(target=udp_listener, daemon=True).start()
    print(f"battery page: http://localhost:{HTTP_PORT}   (Ctrl-C to stop)")
    server = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), H)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
        server.shutdown()
