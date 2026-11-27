# A capturing closure at a `ctl` slot passes `yo check` and emits invalid C

**Severity:** S2 — a `=>` closure that captures a local, bound to a `ctl(...)` type, passes `yo check`; `yo compile` then fails in the C compiler on a `void *` initialised with the closure's capture struct.

- Filed: 2026-11-28, finding F2 of VERDICTS-94 (Fable 5.2, §8), with its probe `p03b`.
- Status: open. Closed by K-3 of [`plans/backlog/CAPABILITIES_AND_HANDLERS.md`](../plans/backlog/CAPABILITIES_AND_HANDLERS.md) (v0.2.82).

## Reproducer

`issues/repros/2026-11-28-a-capturing-closure-at-a-ctl-slot-passes-check-and-emits-invalid-c.yo`:

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
Ask :: (ctl(q : &String) -> i32);
worker :: (fn(ask : Ask) -> i32)(ask(`q`));
main :: (fn() -> unit)({
  base := i32(40);
  (ask : Ask) = (q => (base + i32(2)));
  println(`r=${worker(ask)}`);
});
export(main);
```

`yo check` (v0.2.80, its bundled std, 2026-11-28): `evaluator OK`. `yo compile … --optimize 2 --sanitize address --allocator system`, rc 1:

```text
tmp/r/2026-11-28-a-capturing-closure-at-a-ctl-slot-passes-check-and-emits-invalid-c.c:2347:9: error: initializing 'void *' with an expression of incompatible type '__yo_t_7260113694972626038' (aka 'struct __yo_t_7260113694972626038_struct')
1 error generated.
yo: error: compile: C compiler failed (exit 1) on tmp/r/2026-11-28-a-capturing-closure-at-a-ctl-slot-passes-check-and-emits-invalid-c.c
```

The emitted line is `void* __yo_v_ask = __capture_closure_…_0;`: the `ctl` slot is a bare function pointer and the closure is a struct.

Expected: a compile error at the binding. A handler is capture-free by rule (`docs/en-US/ALGEBRAIC_EFFECTS.md`, "Typing rules for control functions", rule 3: "Handlers must be bare anonymous functions"); the `->` form of the same handler is rejected for reading `base` (VERDICTS-94 `p03`).

## Root cause

As VERDICTS-94 §8 states it, a capturing closure bound to a `ctl` slot passes `yo check`. The evaluator rejects a closure as a control function only when its body contains `unwind` (rule 3), and otherwise accepts it through the `fn`-at-`ctl` direction (rule 5), which does not ask whether the value is a closure. Codegen lowers the slot as a plain function pointer, so the closure's environment has nowhere to go.

## Fix

K-3: a closure at a `ctl` slot is an error with a coded diagnostic, whether or not its body unwinds. Capturing clauses arrive later, under a delimiter that keeps them in their frame (H-1, after K-7).

## Test

None in this filing: the bug is open with no fix. The test lands with K-3: this repro as a `comptime_expect_error` case.
