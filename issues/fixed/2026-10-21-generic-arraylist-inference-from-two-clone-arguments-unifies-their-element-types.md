# Inferring `T` from two `.clone()` arguments of different `ArrayList(T)` types unifies their element types

**Severity:** S2 — a valid program is rejected with a type error naming two unrelated element types. Only a `.clone()` written in argument position fails: binding each clone to a local and passing the local (`a := labels.clone(); count(a)`) is a workaround, and so is dropping the `.clone()`.

**Status:** FIXED 2026-10-22 on `fix/generic-binder-inference` (see "Fix"). Found 2026-10-21 on `perf/share-typevalue-lists` (a test
helper passing `shared_list(labels.clone())` and `shared_list(types.clone())`
to one constructor). Reproduces with the v0.2.67 seed and with a stage-1
compiler built from develop 7def2203b.

## Reproducer

`issues/repros/2026-10-21-generic-arraylist-inference-from-two-clone-arguments.yo`:

```yo
count :: (fn(generic(T : Type), items : ArrayList(T)) -> usize)(items.len());
both :: (fn(labels : ArrayList(String), nums : ArrayList(i32)) -> usize)(
  count(labels.clone()) + count(nums.clone())
);
```

```
error[E0601]: Cannot unify incompatible types: "i32" and "String"
  --> ...:12:37
   |
12 |   count(labels.clone()) + count(nums.clone())
```

Variants measured on v0.2.67:

| form | result |
| --- | --- |
| `count(labels.clone()) + count(nums.clone())` | E0601 |
| `xs := ...; ys := ...; count(xs.clone()) + count(ys.clone())` | E0601 |
| `a := labels.clone(); b := nums.clone(); count(a) + count(b)` | checks |
| `count(labels) + count(nums)` (no `.clone()`) | checks |
| parameter `x : T` instead of `items : ArrayList(T)`, with `.clone()` | checks |

The second call's argument is a METHOD call whose receiver type is generic
(`ArrayList(T).clone`), checked against the expected parameter type
`ArrayList(T)`. The first call's binding of the callee's `T` (`String`)
reaches the second call's inference, which then unifies it with `i32`.

## Where to look (as filed)

The callee's forall `T` is one `SomeT` node shared by every call of `count`;
argument checking against an expected `ArrayList(T)` that has not been
freshened per call would carry the first call's solution into the second.
`issues/questions/2026-10-20-typevalue-constraint-lists-are-stamped-in-place.md`
describes the related in-place writes to a `SomeT`'s lists. Not root-caused.

## Root cause

Not a shared-`SomeT` write. The callee's `T` reached the second call through
the CALLER's environment:

1. The inline FuncVal arm (`src/evaluator/calls/function.yo`) evaluates each
   argument with the callee's declared parameter type as the expected type,
   and paired it with the caller's env: `ExpectedTypeCtx(ty : ArrayList(T),
   env : env)`.
2. `labels.clone()` is a dot-method call, so it runs Step 10 of
   `try_to_call_function_with_arguments` (`src/evaluator/calls/helper.yo`):
   `synthesize_types(return_type, callee_env, et.ty, et.env)`. With the
   method's result `ArrayList(String)` on the expected side and the given
   side's `T` unbound, the synthesizer binds the GIVEN side's `T := String`
   in `et.env`, which is the caller's env.
3. That binding lives in the caller's body frame until the body ends. The
   second call's Step 10 meets the given side's `T` already bound to
   `String`, unifies it with `i32`, and throws E0601 at `nums.clone()`.

The same leak shadows a caller binder of the same name. With a caller
`fn(generic(T : Type), xs : ArrayList(T), names : ArrayList(String))` whose
body calls `count(names.clone())` and then builds `ArrayList(T).new()`, the
caller's `T` read `String` for the rest of the body:
`ys.push(xs(usize(0)))` failed with E0601 "String" and "i32" (measured on
develop `6cd3495c5`). Every workaround in the table avoids step 2: a local
or a `.clone()`-free argument is not a method call, and a bare `T`
parameter is a top-level SomeT, which the FuncVal arm does not pass as an
expected type.

The named-fn path (`try_to_call_function_with_arguments`'s own argument
loop) already pairs a parameter's expected type with the per-call
`callee_env`, so its bindings die with the call. Only the inline FuncVal arm
handed the callee's binders to the caller's env.

## Fix

The inline FuncVal arm gives a generic callee's argument expected type a
child scope of the caller's env: `snapshot_env(env)` plus one private
frame (`push_frame` copies the shared frame list before writing, so the
caller's frame set is untouched). Every caller binding stays visible
through it, `_bind_some_type` adds or shadows only in the private frame,
and the argument's bindings are dropped with it. A non-generic callee keeps
the caller's env (its parameter types carry no binders of their own), and a
`vs_override` expected type is fully concrete and keeps it too.

Measured with a tree build (`fix/generic-binder-inference`): the reproducer
checks (rc 0, was E0601); the caller-binder variant above compiles and its
binary returns the asserted 2; the two-call variant inside a generic caller
checks.

The workaround site that named this issue, `_trp_struct` in
`tests/internal/types_utils.test.yo`, passes `shared_list(labels.clone())`
and `shared_list(types.clone())` inline again.

## Test

`tests/type_soundness.test.yo`: "soundness canary: two method-call arguments
bind one callee's type parameter per call" (`_count_both`, the reproducer's
shape, and `_count_then_own_t`, the caller-binder shadowing). Before the fix
(develop `6cd3495c5`, tree build) the file fails all 74 tests at module
evaluation with `error[E0601]: Cannot unify incompatible types: "i32" and
"String"` at `_count_both`'s second call; after, it passes.
