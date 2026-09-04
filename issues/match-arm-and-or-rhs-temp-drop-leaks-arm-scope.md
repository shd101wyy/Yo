# A `&&` right operand inside a non-begin match arm leaks its temp's drop out of the arm's C scope

## Status

**OPEN** — root cause fully mapped, three fix designs built and rejected (each
broke something subtler; see "Fix attempts"). The correct fix needs branch-scope
tracking in the emitter and is its own project. Until then the WORKAROUND for
authors is trivial: give the arm a `begin(...)` body (the begin path already
publishes its drops correctly) or split the `&&` into separate statements.

## The error (verbatim)

```
/tmp/rvg.out.c:1667:10: error: use of undeclared identifier '_file____priv_temp_11541'
```

(The name is an eval-minted temp: `_` + first 12 chars of the minting module
path + `_temp_<counter>` — `generate_temp_variable_name_prefix`,
`src/utils.yo`.)

## Minimal reproducer (tmp/fixme.yo shape)

```rust
{ String } :: import("std/string");
{ assert } :: import("std/assert");
{ println } :: import("std/fmt");

probe :: (fn(s : String) -> bool)({
  match(
    s.index_of(String.from("=")),
    .Some(i) => assert((i > usize(0)) && (String.from("k=v").len() > i), "arm"),
    .None => assert(false, "none")
  );
  true
});
main :: (fn(io : Io) -> unit)({
  r := probe(String.from("k=v"));
  println(r.to_string());
});
export(main);
```

Plain function or effectful `main` — both fail. The trigger: a **match arm
whose body is not a `begin` block** containing a **`&&`/`||`** whose right
operand **creates an RC temp** (any call returning an owned value). Variants
that PASS: the same `&&` in a `cond(...)` arm; a single `==` (no `&&`); the
arm body wrapped in `begin(...)`.

Under `yo test` the batch runner wraps every test in a match arm on
`YO_TEST_INDEX`, so ANY test body with this shape breaks its whole batch.

## Root cause

`&&`/`||` with side-effectful right operands lower to an if-chain
(`generate_op_and`, `src/codegen/exprs/and_or.yo`): the right operand —
including the declarations of its eval-minted temps — is emitted INSIDE a
nested `if (...) { ... }` block. At chain close,
`_emit_drops_for_conditional_branch` claims the branch-created temps' drops
from `context.pending_deferred_drops`, emits them in-branch, and marks the
targets in `short_circuit_handled_drop_var_names`.

`pending_deferred_drops` is populated by `generate_function_body` (body
begin), `generate_begin`, `generate_case_body`'s **begin-arm** path, and the
async SM segment emitter — but NOT by the **non-begin arm** path. There the
claim finds nothing; the drop stays on the arm value's ExprInfo and the
site-level flush (`generate_deferred_drop_expressions` at the call site /
`match.yo`'s arm tail) emits it AFTER the `&&` if-block closed — outside the
temp's C scope.

## Fix attempts (all rejected — the constraints are the real spec)

1. **Concat-publish the arm's drops into `pending_deferred_drops`** (what the
   begin path does): the claim then also reaches drops rolled up to the
   function-body pending list, whose emission is owned by the effect-unwind
   path (`__yo_effect_escaped` → "drop local variables before early return").
   Result: an UNCONDITIONAL in-branch drop beside the escape-only one — a
   double free whenever a throw inside the arm unwound
   (`json_parse lone high surrogate`, ASan heap-use-after-free; exactly one
   extra `__yo_decr_rc` line vs develop in the emitted C).
2. **Replace `pending_deferred_drops` with the arm's own list** (no concat):
   the unwind path then misses the outer drops during arm generation and the
   same json test fails differently — the throw stops propagating.
3. **Separate `arm_value_deferred_drops` field + in-place (drain) removal of
   claimed drops**: compiles json/string/regex clean and keeps the corpus
   156/156 byte-identical — but the STAGE-2 SELF-COMPILE fails: the claim,
   emitted at chain close, can sit in a DIFFERENT C scope than the temp's
   declaration when the arm body itself nests blocks (observed in the
   compiler's own `declared_c_var_names` machinery: temp declared at
   `/tmp/stage2.c:1779890` inside a nested if, its claim drop at `:1780190`
   outside it — `use of undeclared identifier`). Replacing the drain with a
   filtered copy (relying on the handled-set for the arm-tail flush) hit the
   same stage-2 error — the problem is the claim EMISSION POINT's scope, not
   the list bookkeeping.

The general fix requires the emitter to know which C block a temp was
declared in (a scope stack recorded alongside `declared_c_var_names`), so a
drop is emitted at — or skipped past — the declaration's own block end.
That is emitter architecture work, not a local patch.

## Author workaround (not a fix)

- Wrap the arm body in `begin(...)`: `.Some(p) => begin(assert(p.0 == a, "..."), assert(p.1 == b, "..."))` —
  the begin path publishes its own drops and everything works. This is also
  how `String.split_once`'s tests are written.
- Or split the `&&` into separate statements.

## Where this surfaced

`String.split_once` (first tuple-returning std API) tests asserted
`.Some(p) => assert((p.0 == a) && (p.1 == b), ...)` — exactly the broken
shape; the string-row test batch failed to compile. The tests were reshaped
to `begin` form; this issue tracks the underlying codegen bug.
