# A local function value returning `Impl(Fn)` is called through a `void*`-returning signature

**Status:** FIXED 2026-10-10 (`fix/local-fn-value-impl-fn-result`). **Found:** 2026-10-10, while probing
`issues/fixed/cond-match-tail-adopts-the-abstract-impl-result-type.md` (reproduces on
seed v0.2.56 and on the tree with that fix; independent of `cond`/`match`).
**Severity:** S1 — a valid program that passes `check` and compiles without a
diagnostic crashes at runtime (SIGBUS, rc=138, at `-O2`).

## Repro

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  mk := (fn(x : i32) -> Impl(Fn() -> i32))({
    (f : Impl(Fn() -> i32)) = ({ x }() => x);
    f
  });
  g := mk(i32(7));
  println(`${g()} (want 7)`);
});
export(main);
```

`yo compile repro.yo --optimize 2 -o a.out && ./a.out` exits 138 with no output. The
same function declared at module level (`mk :: (fn(x : i32) -> Impl(Fn() -> i32))(...)`)
prints `7`.

## What the C shows

```c
void __yo_user_main() {
  void* __yo_v_mk = yo_id_18237979924433214527000000;
  void* _file____User_temp_... = (((void* (*)(int32_t))__yo_v_mk)((int32_t)(7)));
  ...
static inline __yo_t_4246070578346537283 yo_id_18237979924433214527000000(int32_t __yo_v_x) {
```

The function returns the closure's capture struct BY VALUE, but the local `mk`'s
type lowers its `Impl(Fn() -> i32)` result to `void*` (the unresolved existential),
so the call site casts the function to `void* (*)(int32_t)`: an ABI mismatch, and
the "closure" `g` is then called through a garbage context.

## Root cause

`try_to_implement_function_by_function_type`
(`src/evaluator/calls/function_type.yo`) stamps the definition expression's
ExprInfo with the DECLARED function type (line ~1677, `info :=
new_expr_info(caller_env, final_func_ty)`), whose result is the bare
`Impl(Fn() -> i32)` SomeT, and only then runs the def-time body evaluation.
When that evaluation finds the body's concrete type, it re-registers the
function's type in the func-type registry with a result SomeT carrying that
resolution (line ~2097, `register_func_type(fn_val_id, t_with_func_result(...,
t_with_resolution(result_box, dts_h)))`), which is what the function's
PROTOTYPE is emitted from: `static inline __yo_t_S yo_id_…(int32_t)`. The
definition expression's ExprInfo was never updated.

A module-level `mk :: (fn ...)` never notices: its calls take the FuncVal arm of
`evaluate_function_call`, which stamps the call result from the callee BODY's
type (`_evaluate_funcval_runtime_call`, the `t_with_resolution(resolved_ret,
rc_conc)` bridge in `src/evaluator/calls/function.yo`). A value BOUND from the
expression — `mk := (fn ...)`, which codegen holds as a runtime function
pointer — is typed from the stale ExprInfo, so its calls resolved to the bare
SomeT: `void*` at the call-site cast and for `g`, and `g()` became a plain
`((int32_t (*)())g)()` call on the struct's bits.

## Fix

At the re-registration site, the definition expression's own ExprInfo type
takes the same resolved result (`info.ty = t_with_func_result(info.ty,
dts_res)`, `function_type.yo` ~2107). The local's type, the prototype and the
call site now agree on the concrete closure type:

```c
__yo_t_S _t = (((__yo_t_S (*)(int32_t))__yo_v_mk)((int32_t)(42)));
__yo_t_S __yo_v_g = _t;
int32_t _r = closure_yo_id_…(&(__yo_v_g));
```

## Probes (`-O2` and `-O0`, before → after)

| Shape | Before | After |
| --- | --- | --- |
| the repro | rc 138 | `42` |
| local fn called twice, and `mk(3)()` directly | rc 138 | `42 10 42 4` |
| captured by a closure (`{ mk }(y) => mk(y)()`) | rc 138 | `105 106` |
| an `Rc` (`String`) capture, the closure copied | rc 138 | `5 5` |
| `Impl(Future(i32, Io))` result (`io.async` body) | `42` | `42` |
| borrowing capture `{ imm(x) }` | E0909 | E0909 (decision 38 A) |
| passed to a `fn(...) -> Impl(Fn)` parameter | rc 138 | rc 138, independent: `issues/a-function-returning-impl-passed-to-a-function-typed-parameter-is-called-through-void-pointer.md` |
| a generic local fn (`mk := (fn(generic(T : Type), ...) ...)`) | C error | C error, independent of `Impl`: `issues/a-generic-function-bound-with-colon-equals-is-called-through-an-undeclared-symbol.md` |

## Tests

`tests/closure.test.yo`: "a local function value returning an Impl(Fn) result"
(called twice, directly, captured by a closure) and "a local function value's
Impl(Fn) result keeps and releases its capture once" (a `Dispose` counter).
Both fail on the unfixed binary (exit 10, SIGBUS) and pass with the fix.
