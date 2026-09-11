# `Channel(T).send` at `T = unit` is CALLED from a spawn closure and never emitted

**Found**: 2026-09-12, working D18b (`Thread(T).spawn` carrying its result,
`plans/STD_API_STABILIZATION.md` §2 D18). **Class**: a specialization that the
call site emits a call to and the collector never registers, so the C has a
call with no declaration. **Status**: OPEN.

## The error

```
error: initializing '__yo_t18' (aka 'struct __yo_t18_struct') with an
       expression of incompatible type 'int'
```

That is clang reporting an IMPLICIT-INT call: the callee has no declaration
anywhere in the translation unit, so C assumes `int`.

## Reproducer

`issues/repros/d18b-thread-zst-channel.yo` — the D18b shape: a generic helper
that spawns a thread whose body sends the callback's result down a
`Channel(T)`, instantiated at `T = unit`.

```rust
_spawn_zst :: (
  fn(generic(T : Type), cb : Impl(Fn(io : Io) -> T), where(T <: (Send, Acyclic))) -> Channel(T)
)({
  chan := Channel(T).new(usize(1));
  sink := chan;
  t := Thread.spawn((io : Io) => {
    sink.send(cb(io));
    ()
  });
  t.join();
  chan
});
```

## What the emitted C shows

```c
static inline void closure_yo_id_15580(void* closure_context, __yo_t21 io) {
  __yo_effect_escaped = 0;
  closure_yo_id_15554(&(((__yo_t28*)closure_context)->cb), io);
  …
  __yo_t18 _file____priv_temp_21781 =
      yo_id_14942_…_rtparam1_2193_ret_enum_yo_id_14941_value_unit_error_unit(
          ((__yo_t28*)closure_context)->sink, 0);
}
```

The call is well-formed — the unit argument is correctly the dead byte `0` —
and the mangled name appears **exactly once in the whole file**: no prototype,
no definition. `grep -c yo_id_14942` is 1. So the specialization was resolved
by the evaluator (the call site knows its mangled name and its return type,
`enum … value_unit error_unit`) and never reached
`CodeGenContext.functions`.

Note the `rtparam1_2193` segment: the second runtime parameter is mangled with
type id `2193`, the generic `T`'s own id, not `unit`. The same id appears in
`_spawn_zst`'s own specialization name. Whether that is the cause (a
registration keyed on a different mangling than the call site emits) or merely
another symptom of the same unresolved-`T` channel is the first thing to
check.

## Relationship to the other half

This is the SECOND of the two errors the D18b repro produced. The first — a
call site binding a `void`-returning closure call to a `void*` temp — is fixed
(`issues/fixed/closure-call-binds-a-void-result-to-a-void-pointer-temp.md`),
and fixing it is what made this one legible: before, the argument was a
`void*` temp of a broken declaration, and the call's shape said nothing.

`plans/STD_API_STABILIZATION.md` D18b names a THIRD blocker, independent of
both: `_capture_judgement_type` resolves a captured closure to its capture
STRUCT and then rejects it as not `Send`. D18b needs all three.

## Where to look

`should_skip_function_codegen` (`src/codegen/functions/declarations.yo`) drops
a spec "whose registered return still carries an unresolved SomeT", and the
NAMED-callee path in `other_fn_call.yo` degrades such a call to an FTT
comment. Neither happened here: the call was emitted as a real call. So either
the spec was never registered at all, or it was registered under a key the
emission loop does not iterate. Start by dumping `function_order` for a name
containing `yo_id_14942`.
