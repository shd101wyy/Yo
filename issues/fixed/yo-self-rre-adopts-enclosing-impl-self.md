# yo-self's return-type-expression re-eval adopts the ENCLOSING impl's `Self` — pointer-method results typed as the outer receiver

**Status: FIXED 2026-08-17.** Surfaced the moment the def-eval fatal re-raise
started firing (issues/fixed/yo-self-check-misses-undefined-variable.md): the
first strict `check` over `std/imm/map.yo` failed with

```
___drop: failed to evaluate the argument expression.
  std/imm/map.yo:133:45:  unsafe.drop((children.add(usize(i))).*);
```

which then failed the imm_map batch compile on BOTH converted wasm legs.
Latent long before that — `YO_DEBUG_SWALLOW=1` shows every earlier stage-1
swallowing the same error; the specialized call-site re-eval always recovered,
so the emitted C was correct and nothing user-visible failed.

## Minimal repro (26 lines, TS rc=0 / yo-self rc=1 before the fix)

```rust
PairE :: (fn(comptime(K) : Type) -> comptime(Type))(enum(A(v : K), B(x : i32)));
Holder2 :: (fn(comptime(K) : Type) -> comptime(Type))(ref(struct(_p : *(void), _n : u8)));
impl(generic(K : Type), Holder2(K), Dispose(
  dispose : (fn(self : Self) -> unit)({
    children := *(PairE(K))(self._p);
    unsafe.drop((children.add(usize(1))).*);
  })
));
```

## Root cause (traced with YO_DEBUG_DISPATCH / YO_DEBUG_CTFE)

The prelude's pointer-arithmetic method is declared `add : (fn(self : Self,
count : usize) -> Self)`. Dispatch specializes it correctly
(`[fmg-cand] … spec=fn(self : *(<enum>), …) -> *(<enum>)`), but the call's
return-type-EXPRESSION re-eval (the `rre` block, calls/function.yo) fires on
the pre-existing `!type_somes_all_resolve_concrete` trigger (the enum payload
carries the unresolved `K`) and re-evaluates the DECLARED return expr — the
bare atom `Self` — via `_trial_eval_ret_type_expr`. `Self` resolves through
`ctx.self_type` FIRST (identifer_and_operator.yo:147), and during a def-time
body eval inside an impl field loop that is the ENCLOSING impl's Self —
`Holder2(K)`'s ref-struct. The adoption arm accepted it (SomeT-free, non-unit)
and stamped the OUTER receiver as `.add`'s result type; the following `.*`
deref then saw a non-pointer, stamped nothing, and `___drop` threw on the
missing info.

TS never leaks here because its re-evaluation runs under `context.SelfType =
dereferencedReceiverType`.

## Fix

`_rre_dot_receiver_type` (calls/function.yo): around the rre's
`_trial_eval_ret_type_expr`, set `ctx.self_type` to the CALL's own
dot-receiver — the static TypeVal receiver when there is one, else the
instance receiver's STAMPED type (any type: the pointer-arithmetic receiver
is `*(T)`, which the stricter `_instance_dot_receiver_self_type` deliberately
rejects), skipping module receivers — and restore it after.

Verified: the repro checks clean, `check std/imm/map.yo` rc=0, and the
imm_map batches compile on both wasm legs.
