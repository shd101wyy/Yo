# `Channel(T).send` at `T = unit` is CALLED from a spawn closure and never emitted

**Found**: 2026-09-12, working D18b (`Thread(T).spawn` carrying its result,
`plans/STD_API_STABILIZATION.md` §2 D18). **Class**: a specialization that the
call site emits a call to and the collector never registers, so the C has a
call with no declaration. **Status**: **FIXED 2026-09-12.** Red-first regression tests in
`tests/thread.test.yo` ("Thread spawn relaying a generic callback's result at
T = unit", and its `T = i32` sibling).

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

## The full chain, end to end (2026-09-12)

Four probe builds, and the mechanism is now known from the call site back to
its cause. Each step below was measured, not inferred.

**1. The emission loop SKIPS the callee, and the call site does not.** A probe
printing every verdict in `generate_function_declarations`' loop:

```
[DECL-LOOP] SKIPPED __yo_fs_14736942439289292961
```

— and that is exactly the symbol the C calls with no declaration. So the
function IS in `function_order`; `should_skip_function_codegen` returned TRUE
there and FALSE at `other_fn_call.yo:2053` (we get a real call, not the
degraded `// Failed to transpile` comment). Two callers, same func_id, opposite
answers.

(Note for anyone re-running this: since #603 symbol names are content hashes,
so the old `yo_id_..._rtparam1_...` spellings in this file no longer appear in
the C. Grep the undeclared name out of the clang error and match it against the
probe output.)

**2. Why it is skipped is correct.** The first gate is

```rust
fn_has_specializations(func_id) && func_params_have_raw_some_type(function_type)
```

whose comment says why: "the def-era ORIGINAL of a function the evaluator
specialized, whose signature still carries a SomeT param — every call
dispatches through a specialization, and the original renders that param as
whichever capture struct the SomeT cell last held — dead". That is right. The
gate's PREMISE is what is false here: this call does not dispatch through a
specialization, it dispatches to the original.

**3. Why there is no specialization to dispatch to.** The specialisation key is
built from the argument types, and the second argument is `cb(io)`, whose type
is `_spawn_zst`'s own generic binder — unresolved in all three channels (the
probe in the section above). So the mint produces the abstract shape, which IS
the def-era original, and the call site names it.

**4. Why the binder is unresolved.** `cb(io)` reaches the NO-CALLEE-VALUE arm
of `evaluate_function_call` (`src/evaluator/calls/function.yo`): `cb` is a
runtime parameter bound VALUELESS, so there is no FuncVal to read a concrete
result off. `T` would still resolve if the env had it — and
`_resolve_some_types_deep` is already called there with the call's env — but
the env in question is the CLOSURE's body env. The closure
`(io : Io) => { sink.send(cb(io)); () }` is defined inside `_spawn_zst`'s body
and carries its DEFINITION env; when `_spawn_zst` is specialised at
`T = unit`, the binding lands in the specialisation's env, which the closure's
body env does not chain to. Its sibling `chan := Channel(T).new(...)` is
evaluated directly in the spec env and resolves fine — which is why `rtparam0`
of the very same call already reads `..._unit_...` while `rtparam1` does not.

The specialisation binder does handle closure params
(`is_closure_param` in `src/evaluator/calls/helper.yo`), but it binds the
param's TYPE — a per-spec rebuild of the declared SomeT seeded with this spec's
capture struct — and never its VALUE. The spec key already folds the closure's
own fid in (`_cl0_closure_…` in the mangled name), so binding the value would
be consistent with the cache rather than a new source of splitting.

**So the fix is one of two, and both are evaluator work:**

- bind an `Impl(Fn(...))` parameter's compile-time FuncVal into the
  specialisation env, so the body's `cb(x)` can read its concrete result; or
- make a closure defined in a generic body evaluate against the
  SPECIALISATION's env rather than its definition env, so the enclosing
  binder resolves.

**What must NOT be done**: making the call site's degrade check read
`get_function_entry(fid).value`, so the two verdicts agree by construction.
That turns the link error into an honest hollow marker and is tempting — but it
masks D18b rather than fixing it, and the program still would not work.

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

## Resolution

`src/evaluator/calls/helper.yo`'s `is_closure_param` binder now registers the
ARGUMENT closure's own concrete result against the declared Fn bound's result
`SomeT`, beside the capture-struct registration already there and in the same
shared-id last-write shape. `cb(x)` in the body then has a concrete type, the
`send` it feeds keys its specialisation on a concrete argument type, and the key
names a real specialisation instead of the def-era original.

**TYPE ONLY, and that is the whole point.** Binding the argument's FuncVal
itself was tried first, and it is wrong: the evaluator can then CALL the closure
at compile time, and `yo check ./src` drops to 245/270 with twenty sites failing
`Expected enum type or primitive type for match expression, got unit`, with the
bootstrap fixpoint broken and a hollow stage 2. It fixes the reproducer and
breaks the compiler. Do not retry it.

| gate | result |
| --- | --- |
| the reproducer | compiles and RUNS — `unit value delivered` |
| `yo check ./src` | 270/270 |
| `yo check ./std` | 175/175 |
| bootstrap fixpoint | **FIXPOINT_HOLDS**, stage2 hollow=0 |
| fast suite | **4153 passed, 0 failed** |
| over-merge canary | **17749 = 17749** |

The last row is the one a passing suite cannot give you. A change that makes two
specialisations key alike shows up as a function-count DROP and as nothing else:
`src/main.yo` was emitted by a baseline compiler and by the fixed one **from the
same tree**, and both define 17749 static functions. With symbol names
normalised the remaining delta is 2441 lines, all type declarations — reordering
plus newly concrete instances such as `ArrayList(ArrayList(Delimiter))`, which
is exactly what a `T` that now resolves is supposed to produce.

### Known-unverified route

There are THREE parameter binders and two of them are call-time. This change is
in the `is_closure_param` branch of `check_if_function_parameter_matches_argument`
(`helper.yo`). No reproducer routes an `Impl(Fn)` argument through
`_evaluate_funcval_runtime_call` (`calls/function.yo`), so that path is NOT
covered and the change was deliberately not mirrored there blind: registering
against a shared `SomeT` id from two places without a reproducer for the second
is how the capture-split bug happened
(`issues/repros/arc-spawn-capture-split.yo`).

### Follow-up worth doing separately

`should_skip_function_codegen` is a SILENT skip, and this bug existed because a
call site named a symbol the emission loop had dropped. Having the emission loop
record what it skipped and assert that nothing calls a skipped symbol would turn
the next instance of this class from a link error into a compiler diagnostic.
