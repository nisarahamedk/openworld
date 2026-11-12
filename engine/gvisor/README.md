# gVisor time engine (spike)

A world-time backend built on [gVisor](https://gvisor.dev). The patched Sentry
(gVisor's user-space kernel) owns every clock the programs in a sandbox can
see. Programs run at real speed while they work. When every program is
waiting, the Sentry jumps all clocks forward to the next timer anyone has set,
so that program wakes up straight away. Apps run unchanged. No KVM is needed.

Status: **spike**, built 2026-11-12 to answer "should the first engine be
gVisor instead of a Firecracker fork?". The answer from the tests below is
yes. The code is proof-of-concept quality.

## What's here

| Path | What it is |
|---|---|
| `tesseract-time-skip.patch` | The gVisor patch (~570 lines, 9 files) |
| `build.sh` | Clones gVisor at a pinned commit, applies the patch, builds `out/runsc`, `out/gvisor-bin/*` and `out/tesscoord` |
| `tests/` | The spike tests below |
| `../../twins/adyen` | The fake Adyen, now with a `--system-clock` mode for running inside a time-controlled world |

## How it works

1. **Clocks.** The Timekeeper adds one number, `skew`, to `CLOCK_MONOTONIC`,
   `CLOCK_BOOTTIME` and `CLOCK_REALTIME`. That covers both the syscall path
   and the vDSO page apps read without a syscall. Time only moves forward.
2. **Knowing every deadline.** Every kernel timer (sleeps, `epoll`/`futex`
   timeouts, timerfd, POSIX timers) and every network-stack timer reports its
   deadline to a registry, so "the earliest deadline in the sandbox" is one
   lookup.
3. **Knowing everyone is idle.** The Sentry is the scheduler: it already
   counts running tasks. Idle means zero running tasks for a short grace
   period (default 2 ms).
4. **Skipping.** Add the gap to `skew`, rewrite the vDSO page, and tell every
   timer to re-check. The owner of the earliest timer wakes up.
5. **Bytes in flight.** TCP bytes written minus bytes read, counted at the
   sandbox's host sockets. If any are in flight, someone is about to wake, so
   the engine doesn't skip.
6. **Quantum (optional).** Round skip targets up to a multiple of Q, so chatty
   timers (Redis's 10 per second, Python's 0.5 s server poll) share one
   wake-up. It is **adaptive**: while services are talking to each other,
   skips land exactly on the next deadline, so a request's 2 s timeout can't
   jump ahead of the reply.
7. **Fork.** gVisor's own `runsc checkpoint` / `runsc restore`. The patch
   makes a restored sandbox resume at exactly the world time it was saved at.
   By default Linux lets wall time jump forward on restore.
8. **Many sandboxes, one clock.** With `TESS_SKIP=coord`, a sandbox doesn't
   skip on its own. `tesscoord` reads every sandbox's state (idle, next
   deadline, bytes sent and received) over runsc's control socket. When all
   are idle and nothing is in flight, it skips all of them by the same amount.

Settings, as environment variables on `runsc`:

| Variable | Meaning |
|---|---|
| `TESS_SKIP=1` | This sandbox skips on its own |
| `TESS_SKIP=coord` | A coordinator (`tesscoord`) decides |
| `TESS_QUANTUM_MS` | Quantum in ms (default 0 = exact) |
| `TESS_GRACE_US` | Idle time required before a skip, in µs (default 2000) |
| `TESS_FREEZE=1` | Keep world time across restore without skipping |

## Results (2026-11-12, cloud container, 4 vCPU, no `/dev/kvm`, systrap platform)

| # | Test | Result |
|---|---|---|
| 0 | gVisor runs here, with no KVM | Yes. Release 20261109 and our own build both run on the systrap platform |
| 1 | `sleep 86400` | Returns in **0.1 s** of host time, including sandbox start-up. One skip, because gVisor has no kernel housekeeping wake-ups (the KVM prototype took 174 s, or 10 s with a 10 s quantum) |
| 1 | 30 days of hourly cron, Python threads and Node `setInterval` (`tests/basic`) | 720/720 ticks, the 17-day timer fires at day 17.0000, wall and monotonic clocks agree to 30 µs. About **2.5 s** each |
| 2 | Postgres 16 + Redis + fake Adyen + a shop service, 30 days, Q = 60 s (`tests/world`) | 720/720 hourly crons. Chargeback webhooks on day 18, 19 and 25. A Redis 7-day TTL expired at day 7.001. Autovacuum ran 31 times. 0 errors. **22 min** of host time (see speed) |
| 2b | Stock **Medusa 2.22.6** + Postgres + Redis, 3 days (`tests/medusa`) | Hourly scheduled job ran 72 times, on the hour. The admin login token works at 12 h and is rejected at 1.5 days (Medusa's real 1-day expiry, on world time). 0 errors. **2 min** of host time, including migrations |
| 3 | Checkpoint Postgres world at day 12, restore 3 times, change each (`tests/fork`) | Each fork resumes at day-12 world time. Each sees only its own new orders. All keep running and skipping independently. Image 49 MB |
| 4 | 15 services all on port 8080, each in its own network namespace, joined by a bridge, called by name (`tests/netns`) | 15/15 reachable. One day skipped in about **10 s**, Q = 60 s |
| 5 | Two sandboxes, one clock: hourly calls between them for 30 days, 2 s client timeout (`tests/twoworld`) | 720/720 OK, 0 timeouts, clocks within 2 ms. **4 s** of host time. With the in-flight check turned off (`-ignore-inflight`), 2 false timeouts: the hazard is real and the byte count fixes it |

### Speed: where the time goes

Skipping removes waiting, not work. Whatever a program does on each wake-up
still costs real time. The slow part of test 2 was Postgres **autovacuum**.
Each minute the launcher forks a worker per database, and forking a large
process under gVisor costs milliseconds.

| One idle day of Postgres, Q = 60 s | Host time |
|---|---|
| default settings | 32.8 s |
| `autovacuum_naptime = 600` | 8.7 s |
| `autovacuum = off` | 5.0 s |

So test settings for the world ("time profiles") matter: longer autovacuum
naptime, fewer heartbeats. They change *when* housekeeping runs, not what the
app does.

## Known gaps (not tested or not done)

- **Raw `rdtsc`.** A program that reads the CPU counter directly bypasses the
  Sentry. Go, Node, Python, the JVM and Postgres use the OS clock, so none of
  the tests hit it. Possible fix: trap `rdtsc` (`PR_SET_TSC`) in stub processes.
- **In-flight bytes inside one sandbox.** Bytes are counted only at host TCP
  sockets (`--network=host`). Traffic inside one sandbox's own network stack
  relies on the grace period. The netstack could count queued segments instead.
- **Restore needs root mode** (`runsc restore` refuses `--rootless`). Forks
  start skipping as soon as they are restored. A "restore paused" option would
  let all forks start at exactly the same world time.
- **The idle check polls** every 200 µs, which costs some CPU. A wake-up from
  the scheduler when the running count hits zero would be cleaner.
- **Not tried yet:** Kafka/JVM, static Go binaries, AWS Emulator (this
  session's network couldn't download its release), long-running checkpoint
  chains, upstream-quality code (flags instead of env vars, gVisor tests).

## Reproduce

```bash
./build.sh                                   # -> out/runsc, out/tesscoord
TESS_SKIP=1 out/runsc --rootless --network=none do sh -c 'date; sleep 86400; date'
TESS_SKIP=1 out/runsc --rootless --network=none do python3 $PWD/tests/basic/cron.py
(cd tests/world && npm install) && TESS_SKIP=1 TESS_QUANTUM_MS=60000 TESS_GRACE_US=500 \
  out/runsc --rootless --network=none do /bin/sh $PWD/tests/world/world.sh $PWD/../../twins/adyen
DEV=$PWD/out tests/twoworld/run.sh           # two sandboxes + tesscoord
DEV=$PWD/out tests/fork/run.sh               # needs root mode for restore
```

Medusa: `npx create-medusa-app@latest medusa --skip-db --no-browser --use-npm`,
set `admin: { disable: true }` in `apps/backend/medusa-config.ts`, copy
`tests/medusa/hourly-reconcile.ts` into `apps/backend/src/jobs/`, then
`TESS_SKIP=1 TESS_QUANTUM_MS=60000 TESS_GRACE_US=500 out/runsc --rootless --network=none do env PGOPTS="-c autovacuum_naptime=600" /bin/sh $PWD/tests/medusa/world.sh <path>/apps/backend`.

Tests use the host's Postgres 16, Redis, Python 3 and Node 22. `runsc do`
runs them on the host's root filesystem with a private in-memory overlay.
