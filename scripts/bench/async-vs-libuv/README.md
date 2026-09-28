# Yo's async runtime vs libuv

Two paired benchmarks: each runs the same workload in Yo and in C on libuv
(one event loop each, small payloads so per-operation overhead dominates).
Always alternate the two binaries per round and compare medians — on a
shared machine the noise is of the same order as the differences.

| Pair | Level | Workloads | Driver |
| --- | --- | --- | --- |
| `../io_bench.yo` + `io_bench_uv.c` | runtime (the `__yo_async_*` ops) | socketpair echo; loopback-TCP echo over 1 and 64 connections; zero-delay timer churn; a 16 KiB file write+read cycle | `scripts/bench-vs-libuv.sh` (POSIX; prints medians and Yo/libuv ratios; runs informationally in CI's I/O budgets job) |
| `bench.yo` + `bench_uv.c` | std (`TcpStream`, `Channel`, `sleep` tasks) | `pingpong` (1 TCP connection), `multi` (8 connections), `timers` (500 timers, 1 ms each) | manual, below (the Windows flow) |

## Running

```bash
# POSIX, the runtime-level pair (libuv from pkg-config, or LIBUV_CFLAGS/LIBUV_LIBS):
YO=$(which yo) YO_STD=$PWD/std REPS=7 bash scripts/bench-vs-libuv.sh

# The std-level pair, any platform:
cc -O2 bench_uv.c $(pkg-config --cflags --libs libuv) -o bench_uv   # POSIX
#   Windows (libuv source at a release tag, clang or cl):
#   clang -O2 -DNDEBUG -D_WIN32_WINNT=0x0602 -Ilibuv/include -Ilibuv/src \
#     bench_uv.c libuv/src/*.c libuv/src/win/*.c -lws2_32 -lpsapi -luser32 \
#     -ladvapi32 -liphlpapi -lshell32 -lole32 -ldbghelp -luserenv -o bench_uv.exe
yo compile scripts/bench/async-vs-libuv/bench.yo --optimize 2 -o bench_yo

./bench_uv pingpong 20000        ;  BENCH_COUNT=20000 ./bench_yo
./bench_uv multi 2000 8          ;  BENCH_MODE=multi BENCH_COUNT=16000 BENCH_K=8 ./bench_yo
./bench_uv timers 20000 500      ;  BENCH_MODE=timers BENCH_COUNT=20000 BENCH_K=500 ./bench_yo
```

## Measured

**Linux** (2026-09-28, WSL2 6.6.87, x86_64, libuv 1.52.1, medians; ratio > 1
means Yo is faster). Runtime-level pair, 7 rounds, ops/s:

| workload | Yo io_uring | Yo epoll fallback | libuv | ring/uv | epoll/uv |
| --- | ---: | ---: | ---: | ---: | ---: |
| socketpair echo | 1,384,299 | 1,334,201 | 1,139,471 | 1.21 | 1.17 |
| TCP echo, 1 conn | 13,196 | 13,260 | 13,190 | 1.00 | 1.01 |
| TCP echo, 64 conns | 267,650 | 262,423 | 261,064 | 1.03 | 1.01 |
| zero-delay timers | 8,496,177 | 10,695,187 | 7,074,637 | 1.20 | 1.51 |
| 16 KiB file cycle, tmpfs | 3,472 | 29,943 | 3,143 | 1.10 | 9.53 |
| same on ext4 | ~5,400 | ~7,000 | ~2,850 | ~1.9 | ~2.5 |

The two TCP rows are bound by WSL2's loopback delivery, ~300–450 µs per
single-connection round trip for any runtime. The socketpair row is each
runtime's own per-hop cost.

Std-level pair, 5 rounds: `timers` 459 K vs 427 K fires/s (1.07); `multi`
13.7 K vs 13.8 K rt/s and `pingpong` ~2.2 K rt/s on both — loopback-bound,
parity within noise.

**macOS** (2026-09-28, macOS 26.6, Apple M4, libuv 1.52.1 from Homebrew, 7
interleaved rounds, medians; ratio > 1 means Yo is faster). Record and
analysis: `plans/reference/MACOS_ASYNC_IO_PERFORMANCE.md`. Runtime-level pair,
ops/s:

| workload | Yo | libuv | Yo/uv |
| --- | ---: | ---: | ---: |
| socketpair echo | 2,690,975 | 3,015,227 | 0.89 |
| TCP echo, 1 conn | 365,714 | 369,261 | 0.99 |
| TCP echo, 64 conns | 1,036,899 | 1,078,431 | 0.97 |
| zero-delay timers | 4,200,798 | 83,026 | 50.6 |
| 16 KiB file cycle | 35,485 | 27,469 | 1.30 |

Std-level pair: `timers` 394 K vs 391 K fires/s (1.01), `multi` 274 K vs
314 K rt/s (0.87), `pingpong` 69 K vs 83 K rt/s (0.83). The std rows are
behind because of std/net's per-operation `io.async` wrappers, not the
backend (`issues/std-net-per-op-io-async-wrappers-cost-a-microsecond-a-round-trip.md`).
Every socket row now makes the same syscalls per round trip as libuv. libuv
has no pkg-config file on Homebrew, so build the twins with
`-I$(brew --prefix libuv)/include -L$(brew --prefix libuv)/lib -luv`. libuv's
zero-delay timer costs ~12 µs a tick on macOS 26, the price of an empty
zero-timeout `kevent()`.

**Windows** (2026-09-28, Windows 11, x86_64, libuv 1.51.0, from #981):
ping-pong at parity (26.7 vs 26.4 µs per round trip), 8 connections ~5%
faster (35.9 vs 33.8 K rt/s). Those runs predate the fixes below. The
`timers` row they reported ("~40×") is withdrawn; see below.

## Corrections (2026-09-28)

#981's first version of this pair was not like for like:

- **`timers`:** `bench_uv.c` armed timer *i* for `1 + (i % 50)` ms, delays
  averaging ~25 ms, while `bench.yo`'s tasks sleep 1 ms. The libuv side was
  therefore capped near 500 timers / 25 ms ≈ 20 K fires/s by construction, which
  is where "Yo ~40× faster on timers" came from. With the same 1 ms delay on
  both sides, Yo is ~7% faster on Linux (above), not 40×. Windows needs
  re-measuring. Its note that libuv never calls `timeBeginPeriod` (every wait
  rounds up to the ~15.6 ms timer interrupt, while Yo's runtime raises the
  resolution) still stands and matters there.
- **`multi`:** the libuv side stopped timing when the FIRST connection reached
  its target (`exit(0)` in the read callback), so it timed less work than the
  Yo side (~15.6 K instead of 16 K round trips) and dropped the slowest
  connection's tail. It now stops when the last one finishes.
- **`multi` teardown** printed "unhandled effect unwind aborted an async task
  that was never awaited": the Yo side never awaited its server tasks. It
  does now.
- `bench_uv.c` read the listener's port with `getsockname` on a `uv_fileno`
  and an `int` length, which is not portable. It uses `uv_tcp_getsockname`.
