# async runtime vs libuv (Windows)

A paired benchmark: the same workloads in Yo (`bench.yo`, one event loop) and
in C on libuv (`bench_uv.c`, one loop, v1.51.0). Small payloads, so
per-operation runtime overhead dominates; everything runs on the loopback
stack with `TCP_NODELAY` on both ends.

## Build & run

```bash
# libuv side (clone at a release tag, compile with clang or cl):
git clone --depth 1 --branch v1.51.0 https://github.com/libuv/libuv.git
clang -O2 -DNDEBUG -DWIN32_LEAN_AND_MEAN -D_WIN32_WINNT=0x0602 \
  -Ilibuv/include -Ilibuv/src bench_uv.c libuv/src/*.c libuv/src/win/*.c \
  -lws2_32 -lpsapi -luser32 -ladvapi32 -liphlpapi -lshell32 \
  -lole32 -ldbghelp -luserenv -o bench_uv.exe

./bench_uv.exe pingpong 20000          # one connection, N round trips
./bench_uv.exe multi 2000 8            # 8 connections, 2000 RTs each
./bench_uv.exe timers 20000 500        # 500 1ms timers, 20k fires
UV_HISTIMER=1 ./bench_uv.exe ...       # also call timeBeginPeriod(1) first
                                       # (plain libuv does NOT — see notes)

# Yo side (a yo built from this tree):
yo compile scripts/bench/async-vs-libuv/bench.yo --optimize 2 -o bench_yo.exe
BENCH_COUNT=20000 ./bench_yo.exe                         # pingpong
BENCH_MODE=multi BENCH_COUNT=16000 BENCH_K=8 ./bench_yo.exe
BENCH_MODE=timers BENCH_COUNT=20000 BENCH_K=500 ./bench_yo.exe
```

Alternate the two binaries per round and compare medians — the machine's
noise is of the same order as the differences.

## Measured (2026-09-28, Windows 11, x86_64, 7/5 interleaved rounds, medians)

| workload                          | libuv     | libuv + hi-res timer | Yo       |
| --------------------------------- | --------- | -------------------- | -------- |
| ping-pong, 1 conn (µs / RT)       | 26.4      | 26.5                 | **26.7** |
| ping-pong, 8 conns (k RT/s)       | 33.8      | 34.5                 | **35.9** |
| timer storm, 500×1ms (k fires/s)  | 8.9       | 9.1                  | **~350** |

Yo is at parity on the RTT-bound single connection, ~4–6 % faster on the
multi-connection aggregate (128-entry `GetQueuedCompletionStatusEx` batches
plus the pooled overlapped structs), and ~40× faster on the timer storm.

## Notes on fairness

- **libuv never calls `timeBeginPeriod`** — every wait it makes (including
  timer deadlines) rounds up to the ~15.6 ms system timer interrupt. The
  `UV_HISTIMER=1` column neutralizes that by raising resolution before the
  loop starts, the same thing Yo's runtime does at init since #974. The
  timer-storm gap is NOT mainly resolution (the hi-res column barely moves):
  it is the timer queue — Yo fires the whole due batch per wake and re-arms
  in-place, where re-arming a `uv_timer_t` from its own callback costs far
  more at this scale.
- The timer storm's Yo side pays full `io.async` task machinery (a state
  machine per timer loop, resumed on every fire) — the libuv side is bare
  `uv_timer_t` callbacks — and Yo still wins by an order of magnitude.
- The teardown of `multi` prints "unhandled effect unwind aborted an async
  task that was never awaited" for the server tasks (they observe the peer's
  close as an error and unwind through the bench's panic handler); the client
  counters — what the measurement uses — are unaffected.
