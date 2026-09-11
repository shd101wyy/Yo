# A call to a captured generic closure binds a `void` result to a `void*` temp

**Found**: 2026-09-12, working D18b (`Thread(T).spawn` carrying its result,
`plans/STD_API_STABILIZATION.md` §2 D18). **Class**: a codegen call site and
the callee's own prototype disagreeing about the C return type. **Status**:
FIXED 2026-09-12 — red-first regression test
`tests/closure_param_forwarding.test.yo`, "Test a captured generic callback at
T = unit".

## The error

```
error: initializing 'void *' with an expression of incompatible type 'void'
```

## Minimal reproducer

`issues/repros/closure-call-void-result.yo`:

```rust
_call1 :: (fn(f : Impl(Fn(n : i32) -> unit)) -> unit)({
  f(i32(1));
});
_run :: (fn(generic(T : Type), cb : Impl(Fn(n : i32) -> T)) -> unit)({
  _call1(((k : i32) => {
    _v := cb(k);
    ()
  }));
});
main :: (fn() -> unit)({
  _run(((n : i32) => ()));
  println(`ok`);
});
```

`yo compile … --optimize 2` emits one C error. The two lines that disagree:

```c
static inline void closure_yo_id_10905(void* closure_context, int32_t k);
…
void* _file____priv_temp_16750 = closure_yo_id_10905(&(((__yo_t8*)closure_context)->cb), k);
```

The prototype says `void`. The call site says `void*`.

## Why they disagree

Both spellings are computed, from different inputs, by code that never
compares them.

The **prototype** is written by `generate_function_declaration`
(`src/codegen/functions/declarations.yo`): the return type is an
`override ?? get_type_string(result)` choice, and for a closure whose
signature result is a `SomeT` the override is the BODY's concrete type. The
closure `(n : i32) => ()` has body type `unit`, so the prototype is `void`.

The **call site** is the `cc_` static-dispatch path in
`src/codegen/exprs/other_fn_call.yo` — a call whose callee resolves through
`impl_closure_call_map` is emitted as `closure_<fid>(&<capture>, args…)`. Its
void decision reads `result_type`, which comes from the CALLER's view of the
callee's Func type: the still-unresolved generic `T`. Two lines conspire:

```rust
// ~:2022 — prefer the call's own resolution, EXCEPT when the expression's
// own type is unit (which also means "value discarded", so it is not
// evidence about the callee).
if(is_some_type(result_type) && !(is_unit_type(ei.ty)), {
  result_type = ei.ty;
});
```

so at `T = unit` `result_type` stays the `SomeT`, and `get_type_string` of an
unresolved `SomeT` is the erasure `void*` — which is neither `void` (so the
statement form is not taken) nor wrong-looking (so nothing complains). The
temp is declared `void*` and initialized from a `void` expression.

Every other instantiation is fine: at `T = i32` the guard's `!is_unit_type`
holds, `result_type` becomes the concrete type, and both sides say `int32_t`.
It is exactly the ZST that falls between the two channels.

## THREE emitters ask the expression, and all three are wrong the same way

Fixing only the call site turns the error into the next one in the stack — the
binding emitter declares the same temp from the same erased type:

```c
closure_yo_id_10905(&(((__yo_t8*)closure_context)->cb), k);   /* fixed */
void* _file____priv_temp_16750 = ;                            /* next error */
void* _v = _file____priv_temp_16750;
```

`src/codegen/exprs/init_assignment.yo`'s scalar path already carries the guard
for this shape —

```rust
rhs_is_unit := is_unit_type(resolve_some_type_to_concrete(effective_type));
```

(issues/fixed/binding-a-unit-returning-call-emits-invalid-c.md) — and it
misses for the same reason the call site did: the RHS's `rei.ty` and the
binding's own `lhs_type` are both the unresolved `T`, and
`resolve_some_type_to_concrete` finds no resolution to walk to. The registry
that would hold one is deliberately not durable for a `generic(T : Type)`
binder (`unregister_some_resolved_concrete`, `src/expr_info.yo`), so by the
time codegen runs there is nothing to read.

## The fix

A `cc_` hit is a STATIC dispatch to a known callee, so the callee's own
emitted signature is the ground truth, and all three emitters ask it.

`declarations.yo` gains two exported helpers:

- `emitted_return_type_string(func_id, context)` reproduces the prototype's
  `override ?? signature` choice from the same three inputs —
  the registered func type, the entry's body, the effect-record-member body
  suppression. `generate_function_declaration` now goes through the same
  extracted `_return_type_override`, so the two cannot drift.
- `static_dispatch_callee_return_type(func_expr, context)` resolves a call's
  callee through `impl_closure_call_map` and answers with the above.

`other_fn_call.yo`'s shared void decision and `init_assignment.yo`'s
`rhs_is_unit` / LHS-declaration guards all consult it.

**Why this cannot regress a working program**: the helper answers `Some("void")`
only where the old code emitted `<erasure> t = <void-returning call>` — C that
never compiled. Every program that reached this path was already broken.

The mirror case (callee says non-void, site says void) is not reachable
today: the site only keeps the erasure when `ei.ty` is unit, which is the
`void` direction.

## Where it was found

This is the first of the two walls `plans/STD_API_STABILIZATION.md` records
against D18b. The other — `_capture_judgement_type` resolving a captured
closure to its capture STRUCT and then rejecting it as not `Send` — is
untouched by this, and D18b needs both.

## Resolution

Measured on the reproducer, `yo compile … --optimize 2`:

| | errors |
| --- | --- |
| before | `void* t = <void call>` |
| after call-site fix only | `void* t = ;` (the binding's spill, one level up) |
| after | **compiles, runs, prints `ok`** |

And on the full D18b repro (`issues/repros/d18b-thread-zst-channel.yo`), which
carries a second independent defect: two C errors → one. The unit argument now
renders as the dead byte `0` the callee's signature expects. What is left is
`issues/generic-channel-send-specialisation-is-called-but-never-emitted.md`.

The regression test asserts more than "it compiles": the callback must still
have RUN exactly once with the forwarded argument, because the fix turns a
declaration into a statement and a statement that was dropped rather than
emitted would be a silent miscompile.
