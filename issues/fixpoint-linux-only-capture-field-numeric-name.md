# Fixpoint (Linux only): async capture field emitted as a raw numeric id

**Status: OPEN** (2026-08-10). The LAST red job on PR #92 — every other job
(14/15) is green. The fixpoint HOLDS on macOS locally; on the Linux runner,
stage-2 emission fails clang with exactly 2 errors:

```
/tmp/yo-stage2.c:1852226:35: error: expected ';' after expression
  sm->result = sm->__capture.9087782;
```

A state machine's capture FIELD NAME resolves to a bare variable id
(`9087782`) instead of the field's C name — an id-keyed name-lookup misses
and something falls back to printing the raw id. Linux-only because
yo-self's module set differs per platform (`codegen/async/runtime_io_linux.yo`
vs `_macos.yo`), which shifts which closure/spec ids exist; the miss is in
whatever table maps captured-variable ids to `__capture` field names in
state_machine.yo / async.yo emission.

## Repro / hunt plan

1. Cross-emit on macOS with `--target aarch64-linux-gnu --emit-c` (the
   established trick from `yo-cross-target-emit-to-debug-other-platforms`):
   `/tmp/yo-s35 compile yo-self/main.yo --release --emit-c --skip-c-compiler
--target aarch64-linux-gnu -o /tmp/linux_s2` then grep the C for
   `__capture\.[0-9]` — should reproduce the numeric field without a Linux
   box.
2. The two error sites sit in fetch.yo-adjacent async closures (same region
   as the bare-if campaign). Find the emitter that prints
   `sm->__capture.<name>` for a RESULT assignment (`sm->result = …`) — the
   name resolution that can return an id: likely `get_state_machine_field_name`
   fallback or the capture-field lookup in `_emit_last_segment_completion` /
   the return-completion path.
3. Fix BOTH compilers if the TS side shares the fallback (check
   state-machine.ts's equivalent).
