# A closure in a generic method, reached from another generic impl, is emitted at that impl's trial type

**Severity:** S2. A valid program fails in the C compiler, depending on its module path. The shape is a generic type's method holding a closure (any `RefCell` `with`/`with_mut` body) called from another generic impl, which decision 46 makes the usual way to write shared state.

**Status:** FIXED 2026-10-20 (branch `fix/generic-impl-method-value-closure-identity`; see "Root cause and fix" at the end). **Found:** 2026-10-17, moving `std/async/channel.yo`'s state into `Rc(RefCell(...))` for decision 46 Generation B (#1421). It is not caused by that change: v0.2.64 with develop's std fails too.
**Reproducer:** `issues/repros/2026-10-17-a-closure-in-a-generic-method-first-reached-from-another-generic-impl-is-emitted-at-the-trial-type.yo`

## Symptom

```yo
{ RefCell } :: import("std/sync/refcell");
{ assert } :: import("std/assert");
St :: (fn(comptime(Item) : Type) -> comptime(Type))(struct(n : usize, x : Option(Item)));
Ch :: (fn(comptime(Item) : Type) -> comptime(Type))(struct(_st : Rc(RefCell(St(Item)))));
impl(
  generic(Item : Type),
  Ch(Item),
  new : (fn() -> Self)(Self(_st : rc(RefCell(St(Item)).new(St(Item)(n : usize(0), x : Option(Item).None))))),
  _add : (fn(self : &Self) -> unit)(
    self._st.with_mut(s => {
      s.n = (s.n + usize(1));
    })
  ),
  count : (fn(self : &Self) -> usize)(self._st.with(s => s.n))
);
Tx :: (fn(comptime(T) : Type) -> comptime(Type))(struct(_ch : Ch(T)));
impl(
  generic(T : Type),
  Tx(T),
  _attach : (fn(ch : &Ch(T)) -> Self)({
    ch._add();
    Self(_ch : ch)
  })
);
main :: (fn() -> unit)({
  c := Ch(i32).new();
  t := Tx(i32)._attach(&c);
  c._add();
  assert(c.count() == usize(2), "two");
});
export(main);
```

`yo check` passes. `yo compile` then fails in the C compiler:

```
w1_q3.c:2646:59: error: incompatible pointer types passing '__yo_t_6107784563514125433 *' (aka 'struct __yo_t_6107784563514125433_struct *') to parameter of type '__yo_t_16177955647484366973 *' [-Werror,-Wincompatible-pointer-types]
```

The result depends on the module path, and is deterministic at a given path:

- With v0.2.64 and develop's std, `w1_q3.yo` fails every time, and `w1_q1.yo` and `w1_q2.yo` (the same bytes) compile.
- The #1421 tree binary fails at every path tried.

Some variants, with the tree binary, three paths each:

- `Tx._attach` calling `ch.count()` (a closure returning a value) fails too, so any closure in the callee triggers it, not `with_mut` alone.
- A `Tx` receiver method calling `self._ch._add()` fails.
- `Tx._attach` calling `ch.bump2()`, a closure-free `Ch` method that calls `self._add()`, compiles.

## What the C shows

The `with_mut` specialization reached from the concrete `Ch(i32)._add` is called with the capture struct of the concrete closure. Inside it, it calls `closure_yo_id_…000001`, whose `s` is `St(T)`, and that `T` is **`Tx`'s binder**: it is the closure minted when `Tx._attach`'s definition-time trial specialized `Ch._add` with `Item := T`. The concrete closure `…000002` (`St(i32)`) is emitted, but nothing calls it.

So one closure literal minted at two types (`func_id` is occurrence-indexed, `anonymous_function.yo`) feeds one `with_mut` specialization. The specialization keeps the trial occurrence's identity, and which occurrence wins depends on evaluation order. The `clfid` cache key in `src/evaluator/calls/helper.yo` should have kept them apart. Suspects:

- the per-node `ExprInfo` of the `with_mut` call in `_add`'s body, shared by the trial and concrete specializations of `_add`;
- the specialization cache of `_add` itself, keyed so that `Ch(T_Tx)` and `Ch(i32)` meet.

Related records: `issues/fixed/forwarded-closure-param-shares-specialization.md`, and the `arc-spawn-capture-split` repro named in helper.yo's closure-identity comment. Possibly the same family, open: `issues/2026-10-16-a-generic-io-async-body-shares-one-capture-struct-across-futures-of-one-generic-producer.md` (one capture struct across instantiations) and `issues/fixed/2026-10-17-a-nested-index-call-on-generic-impls-calls-an-unspecialized-method.md`.

## Workaround in the tree (reverted with the fix)

The first workaround depended on which occurrence wins, so it was path-dependent. `Sender._attach` called a closure-free `Channel._sender()` instead of `_add_sender`. That passed `channel.test.yo` from three scratch paths with both the tree binary and v0.2.64, and then failed from `tests/async/channel.test.yo` in the tree, with the same mismatch one call deeper.

The workaround in the tree (#1421) takes the binder out of the closure's type. `Channel`'s sender count moved out of `_ChannelState(T)` into its own `_senders : Rc(RefCell(usize))`. The closures that count senders now take `n : &mut usize` at every type. A trial occurrence and the concrete one are then the same C function, so calling the wrong one is harmless. `channel.test.yo` passes from the tree path and two scratch paths with both binaries.

The bug itself remains. Any closure whose type mentions the binder is exposed to it. Revert the split when the fix lands. The fix's regression test is this reproducer, compiled from several module paths.

## Measurement round 2026-10-18 (probe build, `YO_DEBUG_CLFID` on a develop tree)

Gated prints at the two places `src/evaluator/calls/helper.yo` folds a
closure argument's `func_id` into a specialization key — the `clfid` push in
`create_specialization_at_call`, and a hit line inside
`_find_specialization_cache` — answer the first suspect directly:

- Compiling the failing `w1_q3.yo`, the program's OWN closures mint **no
  `clfid` cache-key entries at all** (six entries total, all from the
  prelude's own `with`-family calls). The `with_mut` specialization that
  serves both call sites is therefore NOT created through
  `create_specialization_at_call`'s keying: it is minted on the
  generic-impl method-value path (`find_methods_from_generic_impls` →
  `_inject_forall_captures` → the method `FuncVal`'s own specialization
  channel), which carries no closure-identity segment. That is why the trial
  occurrence's identity wins and which occurrence wins follows evaluation
  order — exactly the path-dependence observed.
- Suspect 1 (the per-node `ExprInfo` of the `with_mut` call being shared) is
  NOT excluded by this, but it is now downstream: whatever stamps the fmg
  method-value specialization must key (or mint per) the closure argument's
  `func_id` the way `create_specialization_at_call`'s `clfid` segment does,
  or a trial-minted entry must not be reused outside the trial.
- Fix-site note for whoever picks this up: the twin comment in
  `helper.yo`'s closure-identity block (`issues/fixed/forwarded-closure-param-shares-specialization.md`,
  the `arc-spawn-capture-split` repro) is the working precedent for the key
  shape; the missing half is the same keying on the fmg path.

## Root cause and fix (2026-10-20)

The 2026-10-18 measurement above does not reproduce on develop `6ccddf25d`:
with `YO_DEBUG_CLFID=1` the `with_mut` call in `_add` DOES go through
`create_specialization_at_call` and is keyed per closure mint — three
`[clf-key] … fid=closure_yo_id_…00000{0,1,2}` lines (the `_add` definition
trial at `Item`, `Tx._attach`'s trial at `T`, the concrete `i32` call), and
three distinct `with_mut` specializations. The keying was never the problem.

What the C shows instead:

- ONE `with_mut` body is emitted, the concrete one (its `slot._value` is
  `St(i32)`), and inside it the call `body(&mut slot._value)` names the
  TRIAL mint's closure function `…000001` (`St(T)`).
- That call is a Piece C static dispatch (`src/codegen/exprs/other_fn_call.yo`):
  the callee's capture-struct id is looked up in `impl_closure_call_map`,
  which `register_impl_closure_call_mappings`
  (`src/codegen/exprs/closures.yo`) fills by walking every emitted closure
  function and keying it by its capture struct.
- `s => { s.n = … }` captures nothing, and the capture-struct id
  (`create_capture_type_and_value`, `src/evaluator/utils/closure.yo`) was keyed
  by source position plus capture FIELDS only. Every mint of the literal —
  at `St(Item)`, `St(T)`, `St(i32)` — got the same capture struct, so the map
  held whichever closure the HashMap walk visited last. That walk order follows
  the fids' hashes, which include the module path: the path dependence.

The trial mint is not needed to see it. Two concrete instantiations collide at
every path:

```yo
c := Ch(i32).new();
c._add();
d := Ch(u8).new();
d._add();
```

fails the C compiler with develop's binary from four different paths, with the
same `incompatible pointer types` error.

**Fix:** the capture-struct key also carries the closure's call signature
(`closure_signature_key`: the `type_key` of each parameter type and of the
result), passed in by the two closure-literal callers
(`anonymous_function.yo`, `closure_type.yo`); the specialization caller already
keys by its specialized fid. Two mints that capture the same fields but take
different parameter types now get distinct capture structs, so the map sends
each call to its own closure. A re-evaluation of the same mint has the same
signature and keeps sharing its struct, which is what the key was for.

**Regression tests:** `tests/sync/refcell.test.yo` ("a closure in a generic
method keeps its own capture struct per instantiation", the `Ch(i32)`/`Ch(u8)`
shape; "… reached from another generic impl first", this doc's `Tx` shape).
With develop's binary the batch fails at the C compiler; with the fix 9/9 pass.
`std/async/channel.yo`'s sender count moved back into `_ChannelState`, which
also fails `tests/async/channel.test.yo` at the C compiler with develop's
binary and passes 22/22 with the fix.
