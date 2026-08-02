"""udp_probe.py - listen for PASS node frames on a UDP port and show what arrives.

Works for every PASS wireless node (each has its own port):
    feet -> :5006   knee -> :5005   hip -> :5004

Run on the laptop while the node(s) are powered and on the same WiFi (30.007):
    cd feet
    ../.venv/Scripts/python udp_probe.py            # feet (default 5006)
    ../.venv/Scripts/python udp_probe.py --port 5004   # hip
    ../.venv/Scripts/python udp_probe.py --port 5005   # knee

Success = frames print. For the feet you should see both foot_left and foot_right
and values move when you press a zone; for hip/knee the quaternion fields change
as you move the sensor.
"""
import argparse
import socket

ap = argparse.ArgumentParser(description="PASS UDP node probe")
ap.add_argument("--port", type=int, default=5006,
                help="UDP port to listen on (feet 5006, knee 5005, hip 5004)")
args = ap.parse_args()

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", args.port))
print(f"listening on UDP :{args.port}  (Ctrl-C to stop)\n")

seen = {}
try:
    while True:
        data, addr = s.recvfrom(2048)
        parts = data.decode("ascii", "ignore").strip().split(",")
        if len(parts) >= 3:
            # unit_id-prefixed nodes (feet/hip) start with a label; the knee line
            # starts with a numeric seq, so fall back to the sender IP as the key.
            unit = parts[0] if not parts[0].lstrip("-").isdigit() else f"@{addr[0]}"
            seen[unit] = seen.get(unit, 0) + 1
            print(f"{unit:12s} n={parts[1]:>6}  {len(parts) - 3} fields  "
                  f"from {addr[0]}   seen: {sorted(seen)}")
except KeyboardInterrupt:
    print(f"\nstopped. totals: {seen}")
finally:
    s.close()
