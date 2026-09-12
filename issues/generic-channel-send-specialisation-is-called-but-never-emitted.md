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

## MEASURED 2026-09-12: the resolution does not exist in ANY channel

Three fixes were built and measured, and all three are dead ends. Recorded so
none of them is retried:

1. **Resolve the `rtparam` unit test through the SomeT chain** (the obvious
   reading of the section above). No effect — and the reason is that
   `_spec_resolve_arg_ty` (`src/evaluator/calls/helper.yo`) ALREADY walks both
   the per-object `resolved_concrete` cell and the global registry before the
   argument type reaches `compute_compile_time_signature`.
2. **Add the CALLER-ENV channel** to that resolution
   (`get_value_of_some_type_from_env`). No effect.
3. **Stop refusing a `unit` answer in the call-result resolution**
   (`src/evaluator/calls/function.yo`'s `rt_none_resolved` guard, which rejects
   both `is_some_type` and `is_unit_type`). No effect on this shape. Worth
   knowing anyway, because the `is_unit_type` half of that guard is wrong on
   its own terms — `_do_chain_resolve` returns the SomeT ITSELF on every miss
   (name unbound, non-type value, self-binding, cycle), so it can never hand
   back `unit` as a soft-failure and the clause can only reject a genuine
   `R := unit`. It is a latent defect with no reproducer yet.

A probe at the point the signature's argument types are collected says why:

```
[PROBE-SIG] fid=yo_id_14943 rti=1
            raw=T : (Send + Acyclic)
            cell=T : (Send + Acyclic)
            env=T : (Send + Acyclic)
            key=2193
```

The argument's type is `_spawn_zst`'s OWN generic binder, complete with its
where-clause traits, and it is unresolved in **all three** channels — the
per-object cell, the global registry, and the caller's environment.

**So the resolution is not missing, it does not exist yet.** The
`Channel(T).send` specialisation is minted during an evaluation in which `T`
is still abstract, and nothing ever re-mints it for `T = unit`. Its sibling in
the same function body resolves fine: `chan := Channel(T).new(...)` emits
`Channel(unit)`, which is why `rtparam0` of the very same call reads
`..._unit_...`. The closure that `Thread.spawn` receives is what carries the
abstract evaluation into codegen.

That reframes the whole issue. It is not "which resolution channel is the
signature missing"; it is **why is a call inside a closure defined in a
generic body specialised from an abstract-`T` evaluation, and never
re-specialised when the enclosing function is**.

One more fact worth chasing first, because it may be the cheaper half: the
call site emits a full mangled name, and that name can only come from
`_c_func_name`, which reads `CodeGenContext.get_function_entry`. So the
abstract spec IS registered in `functions` — it is registered and never
emitted. Either `should_skip_function_codegen` drops it at the emission loop
while the call site's identical check at `other_fn_call.yo:2053` did not fire
(different path: is `sink.send(...)` reaching the named-callee arm at all?), or
it was registered AFTER both the declaration loop and the body loop had passed
it. Dumping `function_order` for `yo_id_14943` at the end of collection settles
which.

## Why this is NOT a one-line fix

Resolving `ptype` through its SomeT chain before the unit test makes the two
manglings agree, and that is the right shape. But it is a change to the
signature every specialisation in the compiler is keyed by, so it moves
`yo_id_*` names tree-wide and has to clear the bootstrap FIXPOINT gate — it
belongs in its own PR with the full battery, not bolted onto another fix.

Resolving at read is NOT available here — measured, see the section above. The
resolution has to be RECORDED at specialisation time rather than looked up
later, and that is evaluator work on how a generic body's ExprInfos are stamped
for a specialisation.

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
