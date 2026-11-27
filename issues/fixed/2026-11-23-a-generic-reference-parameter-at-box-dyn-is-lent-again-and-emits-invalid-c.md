# A generic `x : &T` parameter at `T := Box(Dyn(S))` is read as the box and lent again: a bound method call emits `&x` where `x` is expected

**Severity:** S2: a valid generic call passes `yo check` and then fails in the C compiler (`incompatible pointer types`); every `where(T <: S)` helper that takes `x : &T` and calls a method of `S` is unusable at `T := Box(Dyn(S))` when `Box(T)` implements `S` (Rust's `impl<T: ?Sized + S> S for Box<T>` shape, which VERDICTS-78 Q2/Q3 plan for `Display`/`Debug`).

Found 2026-11-23 by the VERDICTS-78 consultation (Fable, reproduced on `f06ff5889` and on the `v0280-s1-test7b` binary); re-verified for this document on develop `4cdc10d31` (tree binary built with `--std-path ./std`).

## Reproducer

`issues/repros/2026-11-23-a-generic-reference-parameter-at-box-dyn-is-lent-again.yo`:

```yo
{ println } :: import("std/fmt");
S :: trait(n : (fn(self : &Self) -> i32));
A :: struct(v : i32);
impl(A, S(n : (self -> self.v)));
impl(generic(T : ?Sized), where(T <: S), Box(T), S(n : (fn(self : &Self) -> i32)(self.as_ref().n())));
via :: (fn(generic(T : ?Sized), x : &T, where(T <: S)) -> i32)(x.n());
main :: (fn() -> unit)({
  (d : Box(Dyn(S))) = dyn(Box.new(A(v : i32(7))));
  println(via(&d));
});
export(main);
```

`yo check` passes (rc 0). `yo compile` fails in clang (the file compiled as `v1.yo`, develop `4cdc10d31`'s tree binary, run inside `nix develop`):

```text
v1base.c:3209:162: error: incompatible pointer types passing '__yo_t_15933190677781987003 **' (aka '__yo_t_8553482633706347625 **') to parameter of type '__yo_t_15933190677781987003 *' (aka '__yo_t_8553482633706347625 *'); dereference with * [-Werror,-Wincompatible-pointer-types]
 3209 |   int32_t _file____home_temp_81930767125078328051 = yo_id_13779655846165546976000000_rtparam0_gs_yo_id_13344885555389465591000000_dyn_trait_v1_S_r0c5_n0_ret_i32((&(__yo_v_x)));
yo: error: compile: C compiler failed (exit 1) on v1base.c
```

The emitted specialization of `via`:

```c
static inline int32_t __yo_fs_1329394305717843297(__yo_t_15933190677781987003* __yo_v_x) {   /* x : &Box(Dyn(S)), a pointer to the pair */
  int32_t r = <Box blanket's n>((&(__yo_v_x)));                                                /* &x: a Box** */
```

The Box blanket's own `n` takes `Box(Dyn(S))*` and reads `self` as `(*__yo_v_self)`.

### Boundaries (same tree)

| Variant | Result |
| --- | --- |
| `via(&a)`, `a : A` (`T := A`) | prints 7 |
| `via(&b)`, `b : Box(A)` (`T := Box(A)`, `?Sized` binder) | prints 7 |
| `via3` with `generic(T : Type)`, `T := Box(A)` | prints 7 |
| `via(&d)`, `d : Box(Dyn(S))` | invalid C (above) |
| non-generic `(fn(x : &Box(Dyn(S))) -> i32)(x.n())`, and `d.n()` | E0616 on develop (`n` of `Box(Dyn(S))` and of its payload, forwarding; F2 removes the second candidate) |

## Root cause

Two consumers disagree on whether the parameter `x` holds a pointer.

- The C prototype takes the ABI from the specialized function type: `fn_abi_param_is_ptr` → `fn_param_is_ptr_borrow` (`src/types/utils.yo`) passes a `&T` slot by pointer when `_dyn_box_pointee` holds, i.e. the pointee is a `Box` whose payload is unsized. At `T := Box(Dyn(S))` the slot is `&Box(Dyn(S))`, so `x` is `Box(Dyn(S))*`, and that rule's own comment says "the by-ref read convention derefs (`(*self)` is the pair)".
- The binding of `x` in the specialized body does not get that read convention. `bind_parameter` (`src/env.yo`) marks a pointer-passed `&T` parameter `is_ref` only when its caller passes `is_ptr_borrow`, and the call-time binder of a `generic(...)` body (`src/evaluator/calls/function.yo`, the `bind_parameter` call in the runtime-call path, `fn_param_is_ptr_borrow(&ci.ty(), pi)`) computes it from the callee's type as the call site holds it, whose slot is still `&T` with `T` a `?Sized` binder: `_dyn_box_pointee(&T)` is false and `_pointee_is_fat(T)` is false (`type_contains_some_type`), so the flag is false. `_pointee_is_fat`'s comment states the intent ("a `?Sized` variable is decided per specialization, where it is bound"); the `Box`-of-unsized case is not decided there.
- With `is_ref` unset, `_var_read_code` (`src/codegen/exprs/atom.yo`) reads `x` as the bare C name `__yo_v_x` (the by-value convention of a thin `&T` parameter), not `(*__yo_v_x)`. The receiver `x` then fills the `&Self` slot of the Box blanket's `n` (slot `&Box(Dyn(S))`), the argument is marked a reference parameter, and `_apply_ref_amp` (`src/codegen/exprs/other-fn-call.yo`) addresses it: it folds a `(*p)` read back to `p`, but a bare name gets `(&(name))`. Result: `&x`, one indirection too many.

At `T := Box(A)` nothing diverges because `&Box(A)` is a thin by-value parameter on both sides; at `T := A` likewise.

Relation to `issues/fixed/2026-11-21-a-reference-binder-whose-type-is-the-methods-own-slot-is-lent-once-too-often.md`: the same surface (a receiver that already has the method's slot type is lent once more), but a different layer. That document was an evaluator rejection (E0601) at `T := &U`, fixed by the receiver riders (#2048); this one is accepted by the evaluator and the extra lend is a codegen ABI mismatch between the prototype and the parameter's binding. It reproduces unchanged after #2048. `issues/2026-11-23-a-generic-body-at-t-ref-c-calling-an-impl-over-ref-c-method-emits-mismatched-c-pointer-types.md` is a neighbour (a by-value `t : T` at `T := &C` lowered `C const *` against a `C *` receiver), not the same fault.

Not traced to the line: whether the def-time binder (`src/evaluator/calls/function-type.yo`, `fn_param_is_ptr_borrow(fn_type_for_foralls, pi)`) or the call-time binder produced the binding codegen read. Both compute the flag from a signature whose slot is `&T`.

## Fix (v0.2.81, VERDICTS-78 PR 0)

`bind_parameter` (`src/env.yo`), the one function every binder of a parameter goes through (the def-time binder, the call-time binder of a `generic(...)` body in `src/evaluator/calls/function.yo`, and `check_if_function_parameter_matches_argument`), decides the Box-of-unsized term of the pointer ABI at the type the parameter binds: a `&T` parameter whose bound type is a `Box` with an unsized payload (`pointee_is_unsized_box`, `src/types/utils.yo`, the predicate `fn_param_is_ptr_borrow`'s `_dyn_box_pointee` now reads) binds pointer-passed whatever its signature says. A specialized body's `x : &T` at `T := Box(Dyn(S))` then reads `(*x)` as the prototype passes it, and the receiver lend folds back to `x`.

Only that term is decided at the bound type. The others already agree or are compensated where they are read: a fat pointee (`T := str`, `T := [U]`) reads as the pair under both conventions (`_var_read_code`'s `vrc_thin`), and a reference pointee (`T := &U`, whose prototype is pointer-passed by `_params_may_store_a_reference`) is read through `_var_read_code`'s pointee-reference arm (`issues/fixed/2026-11-21-a-qualified-call-through-a-blanket-bound-at-t-ref-u-passes-check-and-emits-invalid-c.md`).

## Test

`tests/dyn-pointer-kinds.test.yo`, "a generic &T binder at T := Box(Dyn(S)) calls the Box blanket's method on the box": the reproducer's `?Sized` binder and a sized binder at `T := Box(Dyn(Tally))`, compiled and run, with `T := Box(Cat)` and `T := Cat` as controls. Before the fix the file's batch fails to compile (`incompatible pointer types`, both binders); after it, every test passes.
