# yo-self SIGSEGV evaluating `Impl(Fn(... -> Option(B)))`

## Status

**Reproducible.** Surfaces in `yo-self-bin check` once the bootstrap
evaluator processes the second half of `std/prelude.yo` (past line
~6363, the `impl(forall(T : Type), Option(T), map : ..., and_then :
..., ...)` block). TS evaluator handles the same code without
issue, so this is a bootstrap-only gap. Not a TS codegen bug —
the C output is consistent with the Yo source, the crash is
real evaluator memory corruption.

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

## Where it crashes

Localized via `eprintln` markers (since `lldb` requires codesign
permissions this session can't grant). The crash happens inside
`evaluate_expression_raw(mval_expr, ...)` for the `and_then`
method, called from `evaluator/values/impl.yo`'s Case-2
generic-impl loop (around line 772 in the current file). Specifically:

1. `mval_expr` is the AST for the `(fn(forall(B : Type), self : Self, f : Impl(Fn(a : T) -> Option(B))) -> Option(B))(match(...))` expression.
2. The evaluator processes the function type and its parameters.
3. While evaluating `f : Impl(Fn(a : T) -> Option(B))` — specifically the `Option(B)` inside the `Fn` return — memory corruption occurs.
4. No output reaches stdout/stderr; process exits with SIGSEGV (139).

The crash is non-deterministic in timing — adding/removing
`eprintln` statements can mask or reveal it depending on stack /
memory layout. This is a classic uninitialized-memory or use-after-
free signature.

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
