# Sandbox B: calls the ledger in sandbox A every hour for DAYS days, 2 s timeout.
import json, os, sys, time, urllib.request
days = int(os.environ.get("DAYS", "30"))
time.sleep(1)
ok = timeouts = 0; worst_gap = 0.0; t0 = time.time()
for i in range(days * 24):
    time.sleep(3600)
    try:
        r = json.loads(urllib.request.urlopen("http://127.0.0.1:18080/", timeout=2).read())
        ok += 1; worst_gap = max(worst_gap, abs(r["now"] - time.time()))
    except Exception as e:
        timeouts += 1
print(json.dumps({"calls": days * 24, "ok": ok, "timeouts": timeouts,
                  "worldDaysPassed": round((time.time() - t0) / 86400, 3),
                  "worstClockGapBetweenSandboxesSec": round(worst_gap, 3)}), flush=True)
