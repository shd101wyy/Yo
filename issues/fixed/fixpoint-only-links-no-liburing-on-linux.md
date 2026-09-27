# `fixpoint_only.sh` links no liburing on Linux — the stage-2 clang step always fails there

Found 2026-09-26 while running the handover battery for the
`perf/capture-val-lookups` PR on WSL2.

## Verbatim error

```
ld: /tmp/cv_stage2-*.o: in function `__yo_async_poll_step':
cv_stage2.c:(.text+0x19e59): undefined reference to `io_uring_submit_and_wait'
cv_stage2.c:(.text+0x19e5f): undefined reference to `__io_uring_get_cqe'
...
clang: error: linker command failed with exit code 1
STAGE2_RC=0 CLANG_RC=1 STAGE3_RC=127 FIXPOINT_BROKEN
```

`STAGE3_RC=127` is the missing `/tmp/${P}_s2` binary: stage 3 never ran.

## Root cause

`scripts/bootstrap/fixpoint_only.sh` compiles the stage-2 C with

```bash
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 $SSL_FLAGS /tmp/${P}_stage2.c -o /tmp/${P}_s2
```

resolving OpenSSL via pkg-config but nothing for liburing. Since the Linux
async runtime links liburing (#934 era), every `io_uring_*` symbol in the
emitted C is unresolved. The script was written and only ever run on macOS,
where the async runtime has no ring; CI never hits it because the
`bootstrap-fixpoint` job compiles stage 2 on its own clang line that already
carries `-luring` (`.github/workflows/test.yml`, "Stage 2: compile the
emitted C with clang"). Any Linux developer running the documented gate
(`S1=/tmp/yo-s1 P=local bash scripts/bootstrap/fixpoint_only.sh`) got a
guaranteed `FIXPOINT_BROKEN` unrelated to their change.

## Fix

The script now resolves liburing on Linux exactly like OpenSSL —
`pkg-config --cflags --libs liburing`, falling back to plain `-luring` — and
appends it to the stage-2 clang line. Non-Linux platforms are unchanged.

```bash
URING_FLAGS=""
if [ "$(uname -s)" = "Linux" ]; then
  URING_FLAGS="$(pkg-config --cflags --libs liburing 2>/dev/null || true)"
  [ -n "$URING_FLAGS" ] || URING_FLAGS="-luring"
fi
```

Verified on the WSL2 box (nix clang 21.1.7, liburing 2.12 via nix
pkg-config): `CLANG_RC=0` and the gate proceeds to stage 3.
