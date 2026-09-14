# A local in an `io.async` `while` body, read by two `match`es, is emitted twice

**Status:** RETIRED 2026-09-13 — **NOT REPRODUCIBLE; filed on a wrong premise.**
The shape this doc names emits clean C on develop. The duplicate declaration was
almost certainly collateral of a SECOND defect in the same emit, which this doc
never mentioned because I only read the error I recognised.
**Area:** codegen — the async state machine's local spilling.

## What was actually observed

`/private/tmp/yo-buildaudit-bin/ws-build3.log`, the build that prompted this
file, ended with **two** C errors, not one:

```
yo.c:2363495:143: error: passing '__yo_t49' (aka 'struct __yo_t49_struct') to
                  parameter of incompatible type '__yo_t33' (aka 'struct __yo_t33_struct')
yo.c:2889392:16:  error: redefinition of 'last_sep'
 2889392 |       __yo_t38 last_sep = sm->var_16564534;
yo.c:2889376:16:  note: previous definition is here
 2889376 |       __yo_t38 last_sep = sm->var_16564534;
2 errors generated.
```

`__yo_t33` is `Exception`; the state-machine constructor the note points at is
`yo_id_1219569(__yo_t435* manifest, __yo_t50 io, __yo_t33 exn)`. So the same
`io.async` body was ALSO being handed the wrong exception value at a call site —
an `IoExn` where an `Exception` was wanted, i.e. `…, e)` where `…, e.exn)` was
meant. That is a malformed async body, and this doc was written as though the
duplicate declaration stood on its own.

Both declarations read the SAME slot (`sm->var_16564534`), so the value was
never wrong — only the declaration was emitted twice.

## Why it is retired rather than fixed

Four attempts to reproduce on develop `c4edd4e01`, all emitting clean C:

1. Local bound in an `io.async` `while` body, read by two `match`es, with an
   `await` later in the same body. Compiles and runs.
2. Same, with the `await` inside a nested `if` branch that also contains its
   own `while` — the control shape `expand_workspace_members` has.
3. Local bound BEFORE the await and read by both `match`es AFTER it, so the
   reads straddle a resume point.
4. **The real function.** `_split_member_pattern` inlined back into
   `expand_workspace_members`, restoring the exact source this doc quotes, then
   `yo compile src/main.yo --optimize 2 --emit-c --skip-c-compiler` and
   `clang -fsyntax-only` over the 132 MB result: **0 errors**. A C
   `redefinition` is a semantic error that `-fsyntax-only` reports, so this is
   decisive for the claim as filed.

The `exn`-capture shape can no longer even be written: today the evaluator
rejects it outright with *"Closures cannot capture a value of control-bound
type. The captured value `exn` has type `Exception` which transitively contains
a `ctl(...) -> ret` function."*

So there is nothing here to fix. The honest reading is that a broken async body
produced a broken state machine, and the duplicate declaration was one of its
symptoms rather than an independent bug in local spilling.

## What to do if it comes back

A duplicate `__yo_tN <name> = sm->var_NNN;` in one C scope is still a real
codegen fault if it appears with **no other error in the same emit**. Read the
WHOLE error list first — that is the lesson this file exists to carry. Then
reduce from the failing function rather than from this doc's sketch, because the
sketch was reconstructed from memory and is demonstrably not the failing shape.

§4.6 kept `_split_member_pattern` as a plain `fn`. That stays, on its own
merits — a named split returning a small struct reads better than two `match`es
over one `Option` — but it is no longer a workaround for anything.
