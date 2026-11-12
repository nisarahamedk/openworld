# openworld

A world where software runs for simulated months: real, unmodified services on
one shared, skippable clock, with fake providers (like a fake Adyen) living on
that clock too.

| Path | What it is |
|---|---|
| [`engine/gvisor`](engine/gvisor) | Time engine on gVisor: skip idle time, fork whole worlds, no KVM needed (spike, with results) |
| [`twins/adyen`](twins/adyen) | Fake Adyen: payments, captures, refunds, disputes, signed webhooks, on world time |
