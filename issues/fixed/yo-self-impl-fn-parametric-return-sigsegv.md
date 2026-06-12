# yo-self SIGSEGV evaluating `Impl(Fn(... -> Option(B)))` — RESOLVED

## Status

**Resolved.** Two distinct issues were stacked behind the same
symptom; both are now understood.

1. The initial "SIGSEGV in the and_then impl" was a misdiagnosis —
   the actual error was a clean Yo throw at `std/prelude.yo:5773`
   (`assert :: (fn(flag : bool, (msg : str) ?= "Assertion failed.") -> unit)(...)`),
   where the bootstrap doesn't yet auto-coerce `comptime_string` →
   `str` at default-value sites. The non-raw `evaluate_expression`
   panic-wrapper path was corrupting memory when downstream code
   threw, producing a SIGSEGV at a later prelude site that LOOKED
   like the and_then crash.

2. After fixing (1) by switching the relevant sites to
   `evaluate_expression_raw`, a SECOND silent SIGSEGV appeared
   around iter ~924 (Option.and_then impl eval). lldb showed
   the crash was in `__yo_dispose_dispatch`'s prologue with sp
   near an unmapped page — i.e. **stack overflow** on macOS's
   default 8 MB main-thread stack. Workaround:
   `ulimit -s 65520` before running yo-self-bin. Tracked
   separately in `issues/yo-self-evaluator-stack-overflow.md`.

Resolved by commits:

- `0a5f806c` — `evaluate_fn_trait_type` uses
  `evaluate_expression_raw` for Fn-trait return type.
- `aaa57d7c` — `evaluate_function_parameter` uses
  `evaluate_expression_raw` for default-value expression.
- `440489ca` — Same pattern applied to array/record/enum/field/
  comptime_list type evaluators.

With these fixes, prelude eval now exits 134 with the clean error
message at line 5773 (the underlying assert comptime_string → str
coercion gap), not SIGSEGV 139 at the spurious 6363 location.

## Original (now-corrected) hypothesis

The investigation initially blamed `Impl(Fn(... -> Option(B)))`
HKT/TypeApplication evaluation. After adding the
`kind_function_type` field to `SomeT` (commit `d78e5e14`) without
the segfault going away, deeper instrumentation revealed that
`Option(B)` evaluated correctly — the crash was actually from the
panic wrapper corrupting state when the assert error at line 5773
fired upstream. The crash site at 6363 was a victim of memory
corruption, not the cause.

## Minimal observation

After clearing prelude's earlier coverage gaps via soft fallbacks
(see commits `c8bd5b40`, `952322e4`, `3f69d633`, `a4a83611`,
`46668ef3`, `b48ec4d8`), prelude evaluation reaches line 6363 and
processes the `Option(T)` functional-combinators impl. The methods
evaluate in source order:

| Method     | Body shape                         | Result                  |
| ---------- | ---------------------------------- | ----------------------- |
| `map`      | `f : Impl(Fn(a : T) -> B)`         | **succeeds**            |
| `and_then` | `f : Impl(Fn(a : T) -> Option(B))` | **SIGSEGV** during eval |

Distinguishing factor: `and_then`'s return type inside the inner
`Fn` is a parametric application `Option(B)`. `map`'s is a plain
`SomeT B`. The HKT/TypeApplication path is what crashes.

## Reproducing

```bash
# Bootstrap binary built from current bootstrap/phase-4
bun run build
./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin

# Will SIGSEGV (exit 139) — stdout shows "check: invoking
# evaluate_anonymous_module_begin_exprs" then dies silently
/tmp/yo-self-bin check /tmp/test_simple_prelude.yo
echo "exit=$?"  # 139
```

Sample `/tmp/test_simple_prelude.yo`:

```rust
main :: (fn() -> unit)({
  x := i32(42);
  ()
});
export(main);
```

(Any file works — prelude pre-load is what triggers the crash.)

For comparison, TS handles it fine:

```bash
./yo-cli check /tmp/test_simple_prelude.yo  # exit=0
```

## Where it crashes (precise, post-investigation)

Localized via `eprintln` markers (`lldb` requires codesign
permissions this session can't grant). The crash is in
`evaluator/types/fn_trait.yo:97`:

```rust
evaluated_ret_expr := evaluate_expression(return_type_expr, env_mut, ctx);
```

For `and_then`'s `f : Impl(Fn(a : T) -> Option(B))` parameter, the
inner `Fn(a : T) -> Option(B)` is evaluated by `evaluate_fn_trait_type`.
After the inner params (`a : T`) are processed cleanly, the return
type `Option(B)` is evaluated. The call to `evaluate_expression` on
`Option(B)` crashes with a raw C SIGSEGV — no Yo throw, no
`evaluate_expression: Error` from the panic wrapper.

For comparison, `map`'s inner Fn return is just `B` (atom): single
SomeT lookup, works fine. The crash is specific to evaluating
`Option(B)` as a Fn-trait return type, where `Option` is the
prelude FuncVal and `B` is a forall-bound SomeT in the current
frame.

Crash sequence (from debug eprintlns):

```
DBG-gen-method "and_then" before eval
DBG-fn-trait before params              # outer fn type params
... params evaluated ...
# inner Fn(a:T) -> Option(B) starts
DBG-fn-trait before params              # inner Fn(a:T)
DBG-fn-trait after params, before ret eval, ret_expr=Option(B)
# SIGSEGV — "after ret eval" never prints
```

`Option(B)` evaluates fine in OTHER contexts (e.g. as the OUTER
fn type's return type for both `map` and `and_then`). The crash
is specifically when it's the INNER Fn-trait return inside an
`Impl(Fn(...))` parameter type. The differing context likely
corrupts something (env state? frame layout? — needs lldb).

The crash is non-deterministic in timing — adding/removing
`eprintln` statements can mask or reveal it depending on stack /
memory layout. This is a classic uninitialized-memory or use-after-
free signature.

## What the kindFunctionType port (commit `d78e5e14`) did NOT fix

Adding the `kind_function_type` field to `TypeValue.SomeT` was
the prerequisite for proper HKT support but did not by itself
resolve this segfault. The crash isn't from the missing field
on `B` — `B` is a regular `Type`-kinded SomeT, not an HKT one.
The bug is in some other path (likely in the function-call
evaluator's handling of `Option(B)` when called recursively from
the Fn-trait return-type evaluator).

## Why it's bootstrap-only

TS's `SomeType` has a `kindFunctionType?: FunctionType` field
(`src/types/definitions.ts:238`) that records the "kind" of HKT
type parameters (`F : (fn(T : Type) -> Type)` etc.). yo-self's
`SomeT` variant has no equivalent (gap §5a in
`yo-self-evaluator-gaps.md`). When the bootstrap evaluator
encounters `Option(B)` as a return type inside an `Fn`-trait
constraint, the missing kind information leads to a code path
that dereferences something it shouldn't.

## Suggested fix path

1. Add `kind_function_type : Option(Box(Self))` to
   `TypeValue.SomeT` in `types/definitions.yo`.
2. Update every SomeT constructor site (~104 across yo-self/)
   to pass `.None` as default, including `t_some_t`.
3. Wire the kind through `evaluate_function_parameter` so that
   forall params like `B : Type` (or HKT-kinded `F`) record their
   kind on the SomeT.
4. Use the kind in `TypeApplication` evaluation when `F(A)` is
   evaluated and `F` is a HKT SomeT.

Estimate: 1–2 days of careful work given the ripple. The
post-prelude SIGSEGV here is the next blocker for the bootstrap
to compile/eval real `./tests/*.test.yo` files end-to-end.

## Related

- `yo-self-evaluator-gaps.md` §5a, §5d, §5e
- The soft-fallback chain through `46668ef3` and `b48ec4d8`
  unblocked everything _before_ this point; this is the next
  natural stopping point.
