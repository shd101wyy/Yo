# A closure in a generic method, reached from another generic impl, is emitted at that impl's trial type

**Severity:** S2. A valid program fails in the C compiler, depending on its module path. The shape is a generic type's method holding a closure (any `RefCell` `with`/`with_mut` body) called from another generic impl, which decision 46 makes the usual way to write shared state.

**Status:** OPEN. **Found:** 2026-10-17, moving `std/async/channel.yo`'s state into `Rc(RefCell(...))` for decision 46 Generation B (#1421). It is not caused by that change: v0.2.64 with develop's std fails too.
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

Related records: `issues/fixed/forwarded-closure-param-shares-specialization.md`, and the `arc-spawn-capture-split` repro named in helper.yo's closure-identity comment. Possibly the same family, open: `issues/2026-10-16-a-generic-io-async-body-shares-one-capture-struct-across-futures-of-one-generic-producer.md` (one capture struct across instantiations) and `issues/2026-10-17-a-nested-index-call-on-generic-impls-calls-an-unspecialized-method.md`.

## Workaround in the tree

The first workaround depended on which occurrence wins, so it was path-dependent. `Sender._attach` called a closure-free `Channel._sender()` instead of `_add_sender`. That passed `channel.test.yo` from three scratch paths with both the tree binary and v0.2.64, and then failed from `tests/async/channel.test.yo` in the tree, with the same mismatch one call deeper.

The workaround in the tree (#1421) takes the binder out of the closure's type. `Channel`'s sender count moved out of `_ChannelState(T)` into its own `_senders : Rc(RefCell(usize))`. The closures that count senders now take `n : &mut usize` at every type. A trial occurrence and the concrete one are then the same C function, so calling the wrong one is harmless. `channel.test.yo` passes from the tree path and two scratch paths with both binaries.

The bug itself remains. Any closure whose type mentions the binder is exposed to it. Revert the split when the fix lands. The fix's regression test is this reproducer, compiled from several module paths.
