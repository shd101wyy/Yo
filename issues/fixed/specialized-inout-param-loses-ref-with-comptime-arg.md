# A specialized generic's `inout` parameter loses its ref-ness when the argument is comptime-known

**Status: FIXED 2026-08-25** (branch `fix/specialized-inout-comptime-arg`).
**Found:** 2026-08-25, implementing STD_API_AUDIT D3.10, where it produced a
SILENT wrong answer.
**Severity: high.** One of its two manifestations is a silent miscompile, and the
trigger is ordinary: any generic function with an `inout` parameter, called with a
compile-time-known argument.

## Trigger

specialized (generic) callee **+** an `inout(p)` parameter **+** an argument that
folds to a compile-time constant.

```rust
show :: (fn(generic(T : Type), inout(x) : Option(T), where(T <: ToString)) -> String)(
  match(x, .Some(v) => `Some(${v})`, .None => `None`)
);

show(Option(i32).Some(i32(4)));   // ❌ broken — the argument folds
o := Option(i32).Some(i32(4));
show(o);                          // ✅ fine — a named local binds UnknownVal
show(Option(i32).Some(runtime(i32(4))));  // ✅ fine — not folded
```

Nothing about traits, methods, `self`, or temporaries is required — the minimal
reproducer above has none of them.

## Two manifestations of the one lost flag

**1. The body READS the parameter → invalid C, caught by clang:**

```c
static inline ... f(__yo_t9* self) {
  switch ((self).tag) {                     // '.' on a pointer
    int32_t value = self.data.Some.value;   // same
```

**2. The body FORWARDS the parameter to another `inout` callee → SILENT wrong
value.** `_apply_ref_amp` (`src/codegen/exprs/other_fn_call.yo`) passes a ref
argument by cancelling an existing `(*x)` rendering; with `is_ref` lost there is
no `(*` to cancel, so it takes the address again and passes `T**` where `T*` is
expected. The callee then reads a stack address as a tag, matches no case, falls
through a `switch` with no `default:`, and returns an **uninitialised** value.

That is only `-Wincompatible-pointer-types` in C — and `yo compile` passes `-w`
(`src/main.yo`), so nothing is reported. This is how D3.10's
`Option(i32).Some(i32(4)).format(">10")` returned ten spaces instead of
`   Some(4)`: the blanket `format`'s own `self` was the folded constant, so its
`self.to_string()` call handed `to_string` a `T**`.

## Root cause

Pointer-ness is decided by **two independent channels**, and the fix keeps them in
agreement:

| channel | source |
| --- | --- |
| the C **signature** | the specialized `Func` type's `meta.param_is_ref` (`src/codegen/functions/declarations.yo`) |
| the **body**'s `p` vs `(*p)` | `Variable.is_ref` on the binding found in the atom's recorded `ExprInfo.env` (`_var_read_code`, `src/codegen/exprs/atom.yo`) |

Inside `create_specialized_function_inline`
(`src/evaluator/calls/helper.yo`), a parameter whose binding is a folded comptime
constant is re-bound to a runtime placeholder with `add_variable_to_env`, which
**hardcodes `is_ref : false`** (`src/env.yo`). The re-bind pushes onto the same
innermost frame, and `get_variables_from_env` returns matches in push order with
no shadow collapsing while `_var_read_code` takes the LAST one — so the
placeholder SHADOWS the correct `inout` binding that `check_param` made, for the
whole specialized body evaluation. The registered specialization keeps
`param_is_ref`, so the signature stays a pointer while the body became a value.

The identical defect had already been fixed once in the sibling binder
(`src/evaluator/calls/function.yo`, whose comment describes this exact symptom);
`helper.yo`'s re-bind was missed.

## Fix

Restore the declared flags on the re-bound Variable in BOTH arms of that loop
(the folded-const arm and its closure-parameter twin), reading `param_is_ref` off
the same `func_type` already in scope. This mirrors `check_param`'s own idiom a
thousand lines earlier in the file. Synthesized func types carry an empty
`param_is_ref`, so the lookup yields `.None` → `false` → unchanged behaviour.

`is_reassignable` is restored alongside `is_ref`, because an `inout` body may
assign through the parameter.

**Deliberately not included:** the same re-bind also drops
`is_owning_the_rc_value`. That is a latent sibling for `own(p)` parameters (a
possible missed drop), but it touches RC drop scheduling and needs its own leak
test — a separate change.

## Regression test

`tests/specialized_inout_comptime_arg.test.yo` — reads, forwarding to another
`inout` callee, writing through the parameter, and named-local/runtime controls
that must keep working. Verified RED before the fix (the exact
"member reference type ... is a pointer" errors) and green after.

## Worth following up separately

`yo compile` passes `-w` to the C compiler, which is what made manifestation 2
silent. A pointer-type mismatch between generated code and its own prototype is
never acceptable output; at minimum `-Wincompatible-pointer-types` should survive
`-w`.
