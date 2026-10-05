# The `io.async` capture re-kind pass matches captures to struct labels by name

**Severity:** S1: an uninitialized read in safe code (filed as S2 latent; it
is reachable). A `match` pattern binding that shares a captured variable's
name, read after an await in its arm, reads a C local the resume left
undefined: a `usize` read as `4298353284`, a `String` binding as a wild
pointer.

**Status: FIXED 2026-10-05.** Filed by the review of #1218. **Measured on:**
the v0.2.52 seed and a stage-1 of develop `17e494faa`, `YO_STD` pinned to the
tree's `std/`.

## Symptom

```rust
mk :: (fn(o : Option(String), io : Io) -> Impl(Future(usize, IoExn)))({
  x := String.from("seven");
  io.async(e => {
    a := x.len();                  // the capture `x`
    r := match(
      o,
      .Some(x) => {                // a pattern binding named `x`
        e.io.await(sleep(u64(1)), e.io);
        x.len()                    // read after the await
      },
      .None => usize(0)
    );
    return((a * usize(100)) + r);
  })
});
```

With `o = .Some("abcdefghijkl")` the result must be 512. It was `4298353284`.
The same arm with the binding named `y` returns 512.

## The shape that reaches it

The doc first guessed "a body local declared in a sibling scope with a captured
variable's name". The no-shadowing rule rejects that shape: a `:=` or a
destructuring anywhere in the body collides with the captured name
(`Variable "x" is already defined here (variable shadowing is not allowed)`).
Two kinds of binding are exempt from that rule:

- a `match` pattern binding (by design: `.Node(_, t)` against a scrutinee `t`,
  `tests/internal/match_binding_shadow.test.yo`);
- a nested closure's parameter.

Both put a second binding named `x` into the body's suspension analysis beside
the capture `x`.

The await has to really suspend (`sleep`). A future that completes inline never
leaves the resume function, so the C local survives and the result is right by
accident.

## Root cause

The re-kind pass in `generate_async_block` (`src/codegen/exprs/async.yo`)
turned every analysis entry whose NAME is a capture-struct label into
`CapturedVariableKind.Outer`. The pattern binding is named `x`, so it became
`.Outer` too, and every consumer then treated it as a capture:

- `_inline_binding_sm_field` (`match.yo`) looks for a pattern binding's slot
  among `.Local` entries only, so the binding got no `sm->var_x_<hash>` slot;
- `_block_cross_boundary` never gave it a field.

So the arm declared `__yo_v_x` as a C local, and the read after the resume
label read the value the jump back into the function had left undefined:

```c
__yo_t_… __yo_v_x = sm->__capture.__yo_v_o.data.__yo_v_Some.__yo_v_value;
…                                  /* the await: return, resume */
size_t … = String_len(__yo_v_x);   /* garbage */
```

The capture struct is name-keyed (`create_capture_type_and_value` builds it
from a name → info map), so its labels alone cannot tell which of two bindings
named `x` is the captured one. #1218's alias-owner rule had the same name test
(`cap_labels.contains(owner name)`).

## Fix

A capture is identified by its declaration site.

- `FuncCapturedVarInfo` gains `decl_site`, `module:row:col` of the captured
  `Variable`'s token, set by `enrich_captured_variables`. It has the format of
  `SuspensionCapturedVariable.decl_site`, and both come from the same
  `Variable`.
- `create_capture_type_and_value` records each field's binding with
  `register_capture_field_decl_site(struct id, label, site)`
  (`src/evaluator/types/field.yo`). Re-evaluations of one closure share its
  struct id, so a label accumulates every site they resolved it to. Each of
  those sites is a binding declared outside the closure.
- The re-kind pass asks `is_capture_field_binding(struct id, name, site)` for
  both of its tests: which entries become `.Outer`, and which alias owners it
  drops (the alias is a capture and the owner is not). There is no name
  fallback: a capture struct with fields and no recorded sites is a
  `codegen_fatal`.

After the fix the binding has its own slot and the capture keeps its field:

```c
__yo_t_… __yo_v_x = sm->__capture.__yo_v_o.data.__yo_v_Some.__yo_v_value;
sm->var_x_14008941601240840166 = __yo_v_x;
…
size_t … = String_len(sm->var_x_14008941601240840166);   /* the binding */
size_t … = String_len(sm->__capture.__yo_v_x);           /* the capture */
```

## Tests

`tests/io_async_capture_identity.test.yo`:

- a `String` pattern binding and a scalar pattern binding named like a capture,
  each read after a `sleep` await, with the capture also read (the scalar one
  after a second await): **red before the fix** (exit code 6 in both);
- canaries: a nested closure's parameter named like the capture (the analysis
  lists it too, and the name test re-kinded it), and an alias reassigned in a
  block from a block-scoped local, with a later local of that name captured
  beside it.

## Verification

- `tests/io_async_capture_identity.test.yo`: develop stage-1 **1 passed / 2
  failed** (exit code 6 on both pattern-binding shapes, the canaries pass);
  with the fix **3 passed**.
- A/B emission: a stage-1 of develop `17e494faa` against the fixed stage-1,
  both seed-built (v0.2.52, `--std-path ./std`) and run under one pinned
  `YO_STD`. `src/main.yo` (1,916,666 lines of C) is **byte-identical**. So are
  the kept runner batches of `tests/async_await.test.yo` (3 batches),
  `tests/io_async_captured_alias.test.yo`, `tests/closure_inside_io_async.test.yo`,
  `tests/closure.test.yo` and `tests/rc.test.yo`, each compiled from one fixed
  path by both binaries.
- The one batch that differs is the new `tests/io_async_capture_identity.test.yo`,
  22 diff lines, all in its own shapes. The String binding gains its
  `var_x_<hash>` slot, stored at the binding and read after the await. The
  scalar binding `n` gains a slot (`slot_0`, shared with `r`, whose ranges do
  not overlap). The nested-closure-parameter canary gains two `size_t var_x_…`
  fields that nothing reads or writes: a parameter named like the capture is
  now treated like any other nested closure parameter, which already got such
  dead fields before the fix (filed as
  `issues/an-io-async-state-machine-declares-dead-fields-for-a-nested-closure-parameter.md`).
  `__yo_incr_rc`/`__yo_decr_rc` counts are unchanged (21/172).
- `yo check ./src` passes.
