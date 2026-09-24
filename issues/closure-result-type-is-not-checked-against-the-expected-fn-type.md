# A closure's result type is never checked against the expected `Fn(...) -> R`

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 1).
**Status:** PARTIALLY FIXED 2026-09-24 (Phase 1.2 of `plans/TYPE_SYSTEM_SOUNDNESS.md`): every
shape against a CONCRETE `Fn(...) -> R` is rejected. OPEN for a generic callee
(`Impl(Fn(x : T) -> T)`), which needs the per-call unification of Phase 2.4 — see "Remaining".
Originally: soundness hole, wrong program, green `yo check`, runs and prints a wrong value.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro

```rust
{ println } :: import("std/fmt");
apply :: (fn(f : Impl(Fn(x : i32) -> i32), v : i32) -> i32)(f(v));
main :: (fn() -> unit)({
  r := apply(x => true, i32(3));
  println(`${r}`);
});
export(main);
```

`yo check`: `evaluator OK`, rc=0. `yo compile --optimize 2` rc=0, the binary prints `1`.

The same happens with `(x) -> true`, with a generic `Impl(Fn(x : T) -> T)` callee, and with a
`unit` block body `x => { println(...); }` passed where `-> i32` is expected (all MEASURED).

## Expected

`error[E0604]: Function body has type bool, but the declared result type is i32.` at the closure.

## Mechanism (READ)

- `src/evaluator/values/anonymous_function.yo` (~1583-1621): when a `=>` literal is checked
  against an expected `Impl(Fn(...))`, the closure *adopts the expected wrapper type as its own
  type*. The in-code comment says so: "the closure TAKES ON the expected Impl(Fn) wrapper, so the
  call's Step-6 synthesis sees a SomeT — not a Func — on the given side".
- The only body-vs-declared-result check (E0604, `src/evaluator/calls/function_type.yo`
  ~1698-1730) runs on the named-fn / `->` literal path, not on the `=>` closure path.
- The emitted C declares the closure `static inline bool closure_...(void*, int32_t x)` and calls
  it from a wrapper returning `int32_t`; C's implicit `bool -> int32_t` conversion hides the error
  (MEASURED, emitted C).

## Fix direction

After `_trial_eval_anon_body`, when the adopted `Func.result` is concrete and the body type is
concrete and not control-flow, require `are_types_compatible(body_ty, result)` and raise E0604 with
the same guard `function_type.yo` uses. Add a `comptime_expect_error` test for each of the four
shapes above.

## Related

- `issues/generic-fn-body-is-not-checked-against-its-declared-result-type.md` (same missing check
  on the generic path).
- `issues/closure-body-type-errors-are-swallowed-into-a-runtime-abort.md`.

## Fix (2026-09-24, concrete result)

`src/evaluator/values/anonymous_function.yo`, after the closure-body trial: when the adopted
`Func.result` and the body type are both SomeT-free, the body must be compatible with the result,
under the named-fn path's guards (a control-flow tail, `void` and `Type`-kinded results are
skipped). A mismatch is E0604 at the body, with the named path's `;`-tail hint for a unit body.
It found one violation in `std/`: the prelude's `ComptimeIndex` impls for `comptime_str` returned
a `comptime_str` where the trait promised `comptime(*(Self.Output))`. The three
`__yo_comptime_string_index*` builtins now return a comptime pointer, like the array and list
builtins (`std/prelude.yo`, `src/evaluator/builtins/comptime_index_fns.yo`).

`tests/type_soundness.test.yo` covers `x => true`, `(x) -> true` and a `;`-terminated block
against `Fn(x : i32) -> i32`, plus a canary for well-typed closures.

## Remaining (MEASURED 2026-09-24)

```rust
applyg :: (fn(generic(T : Type), f : Impl(Fn(x : T) -> T), v : T) -> T)(f(v));
main :: (fn() -> unit)({ println(`${applyg(x => true, i32(3))}`); });
```

still prints `1`. The closure is evaluated while `T` is unbound (argument order), and its bare
`-> T` result is then bound to `bool` from the body while `v` binds `T` to `i32` — two concrete
bindings of one binder that nothing compares. That is
`issues/generic-type-var-rebinds-per-argument.md`; Phase 2.4 (solve non-lambda arguments first,
reject a second disagreeing binding) closes it, and this doc moves to `fixed/` with it.
