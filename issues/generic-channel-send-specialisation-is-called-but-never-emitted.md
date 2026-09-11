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

## ROOT CAUSE (measured 2026-09-12): two manglings of the same specialisation

Add a direct `Channel(unit).send(())` in `main` — which forces the
specialisation to be collected from a call whose argument type is plainly
`unit` — and the C gains a prototype AND a definition, while the closure's
call STILL does not link:

```
warning: call to undeclared function 'yo_id_14942_…_rtparam1_2193_ret_enum_…'
```

Diffing the declared name against the called one, they agree for 509
characters and then:

```
decl: …_std_sync_atomic_yo_ret_enum_yo_id_14941_value_unit_error_unit
call: …_std_sync_atomic_yo_rtparam1_2193_ret_enum_yo_id_14941_value_unit_error_unit
```

The declaration omits the second runtime parameter from the mangled signature;
the call includes it, as type id `2193` — the generic `T` itself.

`_compute_compile_time_signature` (`src/evaluator/calls/helper.yo:1412`) is
where they part:

```rust
ptype := match(runtime_param_tys.get(rti), .Some(t) => t, .None => t_unit());
if(!(is_unit_type(ptype)), {
  seg := `rtparam${rti.to_string()}_${sanitize_for_sig(type_key(ptype))}`;
  parts.push(seg);
});
```

`is_unit_type` is the SHALLOW test — it does not walk the SomeT resolution
chain — and `type_key`'s SomeT arm deliberately keys by the SomeT's OWN id
rather than hopping through its resolution cell (the comment there records why:
a blanket hop over-merged the dyn/box closure-wrapper family). So the same
parameter contributes NO segment when the caller sees `unit` and the segment
`rtparam1_2193` when it sees the still-unresolved `T`. Two signatures, two
specialised func ids, one runtime function: the callee is emitted under one
name and called under the other.

Without the warm-up call there is no second caller, so the only specialisation
is the `rtparam1_2193` one — and that one is never emitted at all, which is the
form the D18b repro shows.

## Why this is NOT a one-line fix

Resolving `ptype` through its SomeT chain before the unit test makes the two
manglings agree, and that is the right shape. But it is a change to the
signature every specialisation in the compiler is keyed by, so it moves
`yo_id_*` names tree-wide and has to clear the bootstrap FIXPOINT gate — it
belongs in its own PR with the full battery, not bolted onto another fix.

It is also probably not sufficient on its own. With the segment omitted, the
closure's call mints the spec with a param type that is still the raw SomeT,
and `should_skip_function_codegen` drops a spec whose signature carries one
(`func_params_have_raw_some_type`) — which would put us back at an emitted call
to an unemitted callee, just under a different name. The spec's PARAM TYPES
need the resolution too, not only its name.

## Where to look

`_compute_compile_time_signature` (`src/evaluator/calls/helper.yo`, the
`rtparam` loop), `type_key`'s `SomeT` arm and `_tk_resolve_arg_slot`
(`src/types/type_key.yo`), and `should_skip_function_codegen` /
`func_params_have_raw_some_type` (`src/codegen/functions/declarations.yo`).
