# Self-hosted DEBUG-mode emission of the compiler produces undeclared temps

**Status: OPEN** (found 2026-08-10 by P2.2's first `yo build` self-build).
Not on the P2 critical path — the canonical self-build compiles at
`--release`, which is clean (stage-2/stage-3 fixpoint holds) — but debug
builds of large programs under the self-hosted compiler are miscompiled.

## Symptom

`yo-s26 build` (before the option-forwarding fix, so the child compile ran
with NO `--release` — debug mode, -O0) emitting `yo-self/main.yo` produced a
110 MB `yo.c` that fails to compile with **16 errors**, all one shape:

```
yo.c:1856603:43: error: use of undeclared identifier '_file____User_temp_939118'
 1856603 |               _file____User_temp_939121 = _file____User_temp_939118;
```

A temp named from the module-path prefix (`file:///Users/…` sanitized) is
ASSIGNED FROM in one location but its declaration was never emitted.

## Repro

```bash
# TS-built stage-1 WITHOUT --release on the self-compile:
./yo-cli compile yo-self/main.yo --release -o /tmp/yo-s1
/tmp/yo-s1 compile yo-self/main.yo -o /tmp/yo-dbg     # ← debug-mode emission
# → clang: 16 × "use of undeclared identifier '_file____User_temp_N'"
```

The same input at `--release` compiles clean (that IS the fixpoint gate), so
the divergence is specific to the debug path — plausibly the debug-runtime
selection or a drop/dup emission difference that only debug mode takes.

## Why it stays open for now

Every bootstrap gate and the canonical `build.yo` build at -O2; nothing in
P2's critical path emits the compiler in debug mode. It matters the day
someone wants `optimize: Debug` on a large artifact — reduce from the 16
sites in the emitted C (`grep "use of undeclared" → the temp ids → their
single assignment sites`) when picked up.
