import json
import sys
import time

sequence = 0
for line in sys.stdin.buffer:
    request = json.loads(line)
    operation = request.get("op")
    if operation == "crash":
        raise SystemExit(17)
    if request.get("delay_ms"):
        time.sleep(request["delay_ms"] / 1000)
    sequence += 1
    result = {"op": operation, "sequence": sequence}
    for key in ("marker", "response"):
        if key in request:
            result[key] = request[key]
    reply = {"version": 1, "ok": True, "result": result}
    print(json.dumps(reply, separators=(",", ":")), flush=True)
    if operation == "close":
        break
