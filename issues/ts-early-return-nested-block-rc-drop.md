# TS codegen: `return(x)` of an RC container from inside a nested if-block frees the returned value

**Status:** OPEN — TS-compiler (src/codegen) bug, worked around in yo-self
**Found:** 2026-07-23, during the io.async FSM round-5 hang forensics
**Severity:** high (silent data corruption: caller receives a freed/zeroed container)

## Symptom

In TS-compiled yo-self (s1), `split_body_at_suspension_points`
(yo-self/codegen/shared/suspension_codegen.yo) had this shape:

```rust
segments := ArrayList(SuspensionSegment).new();
if(!(ast_expr_is_fn_call_of(body, "begin", .None)), {
  ...
  segments.push(SuspensionSegment(...));
  return(segments);        // ← early return from inside the if-block
});
... // begin path, falls through to `segments` tail
```

Every caller that hit the early-return path received a list whose `len()`
read **0** immediately after the call — and **garbage (22)** on later reads
of the same memory — while a printf probe INSIDE the function confirmed the
push happened and the path was taken. Classic use-after-free signature: the
function-scope `segments`' deferred drop appears to run on the nested-block
escape path, freeing the buffer that was just returned.

Downstream effect: every io.async closure whose body is a bare non-begin
expression (File.close's `(e) => cond(...)` shape) got an EMPTY resume
function (`switch (sm->state) { }`) — the machine never completed and all
awaiting parents hung (the fs/file flag-on hang).

## Repro pointers

- Yo-self-level repro (before the workaround): flag-on compile of
  `issues/repros/io-async-bare-cond-await-empty-resume.yo` → SEGPROBE
  segments=0, binary hangs.
- A MINIMAL TS-level repro still needs to be written (a `.yo` fn that
  early-returns a pushed-to ArrayList from inside `if(cond, {...})`, caller
  asserts `len() == 1`). Note: this pattern appears all over yo-self and the
  corpus passes, so the trigger is NARROWER than the bare pattern — plausibly
  the interplay with `if(!(...), {...})` negation, the local having a
  same-scope declaration + nested-block return, or the dup/drop optimizer's
  consumed-var tracking for the returned value. Bisect from the
  suspension_codegen.yo shape.

## Workaround (landed in yo-self, FSM round 5)

`split_body_at_suspension_points` restructured to if/else with the begin path
extracted into `_split_begin_body_into(segments, ...)` — no early return; the
function has a single tail `segments`. This fixed the empty-resume class
(fs/file 13/13 flag-on).

## Follow-up

1. Write the minimal TS-level repro and add it to `tests/` (must FAIL before
   the TS fix, per the testing rules).
2. Fix the TS drop emission for the escape path.
3. Grep yo-self for other `return(<rc-local>)` from nested blocks that could
   silently corrupt (any function whose callers see mysteriously empty
   containers).
