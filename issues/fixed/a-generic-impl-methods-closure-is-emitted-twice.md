# A generic impl method's closure is emitted twice — once with `T` unresolved

**Status:** FIXED 2026-09-12 (`fix/zst-closure-fn-result`, the D18b branch).
**Found:** 2026-09-12, while making `Thread(T).spawn` generic for D18b
(`plans/STD_API_STABILIZATION.md` §2 D18).

## Symptom

```
error: call to undeclared function
  'yo_id_5289381407409241382000000_rtparam0_R_gs_yo_id_13379739660580646774000000_2192
   _rtparam1_2192_ret_enum_r8818c2_n83_value_unit_error_2192'
note: did you mean '..._rtparam0_..._i32_rtparam1_i32_ret_enum_..._i32'?
error: initializing '__yo_t_14215415340886002156' with an expression of
  incompatible type 'int'
```

`2192` is an UNRESOLVED `SomeT` id where a concrete type belongs. The
"did you mean" the C compiler offers is the correct symbol — the specialised
one, which IS emitted, right next to the broken call.

## Minimal reproducer

`issues/repros/generic-impl-method-closure-emitted-twice.yo` — no threads, no
async, stock std:

```rust
Holder :: (
  fn(comptime(T) : Type, where(T <: (Send, Acyclic))) -> comptime(Type)
)(ref(struct(_result : Channel(T))));
impl(
  generic(T : Type),
  Holder(T),
  where(T <: (Send, Acyclic)),
  make : (fn(v : T) -> Self)({
    ch := Channel(T).new(usize(1));
    sink := ch;
    runner(
      (io : Io) => {
        sink.send(v);
        ()
      }
    );
    Self(_result : ch)
  })
);
```

Three properties pin it down:

| shape | result |
| --- | --- |
| generic FREE fn (`comptime(T) : Type` OR `generic(T : Type)`) with the same closure | **compiles** |
| generic IMPL METHOD, closure never reached (method not called) | **compiles** (nothing is emitted at all) |
| generic IMPL METHOD, method called once | **fails** as above |

So it is neither a def-time body evaluation (the uncalled method emits
nothing) nor anything to do with threads (`Thread` was only the messenger).

## Root cause

One source closure is evaluated SEVERAL times — the header on
`mark_closure_for_codegen` in `src/evaluator/values/anonymous_function.yo`
spells this out, and `stable_func_id`'s contract ("UNIQUE PER MINT — a trial
and a real evaluation of one function … must never share a fid") makes each
evaluation mint its own `closure_yo_id_<h><occ>`.

For a generic impl method, calling it once produces TWO generations:

* `closure_…000000` — evaluated with the impl's `T` still a bare `SomeT`. Its
  capture struct is `{ cb, sink : Channel(T) }`, so `sink.send(v)` keys the
  callee's specialisation on the unresolved `T`.
* `closure_…000001` — the substituted generation. This is the one the call
  site references, and the only one any spawn wrapper points at.

Both are marked `is_closure_fn`, and `should_skip_function_codegen`
(`src/codegen/functions/declarations.yo`) returns `false` for EVERY
`is_closure_fn` before any generic test runs. So the dead generic generation
is emitted, and it does not compile.

Its own skip set never fired because a closure's genericity does not live in
its signature: `(io : Io) -> unit` is fully concrete. It lives in the CAPTURE
STRUCT, which for a closure is part of the calling convention — it arrives as
`void* closure_context` and every field read casts through it.

## Fix

`should_skip_function_codegen` applies the SAME predicate the hard-generic
param skip uses — `type_contains_some_type_for_codegen_param` — to the
closure's capture type, before the `is_closure_fn` exemption. That predicate
already excludes `Impl(Fn)` / `Impl(Future)` and extern-opaque `SomeT`s, so an
ordinary closure-capturing-a-closure is untouched.

Proving the skipped text is not load-bearing (the standing rule for any guard
that skips emission):

* In the reproducer's C, `closure_…000000` appears in exactly two places — its
  own forward declaration and its own definition. Nothing calls it, and the
  spawn wrapper names `…000001`.
* The over-rejection canaries are the whole existing suite: a closure that IS
  referenced and gets skipped becomes a LOUD "call to undeclared function",
  never silent wrong behaviour.

## Tests

* `tests/thread.test.yo` — `Thread(T)` at `T = unit` and `T = i32` (D18b).
* `tests/closures.test.yo` — the generic-impl-method closure shape itself,
  with no threads, so the regression is caught by the fast suite.
