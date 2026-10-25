# A `Dyn(Fn)` field call used as an operand runs after a later argument's hoisted call (use after free)

**Severity:** S1 — miscompile of evaluation order: an earlier operand's closure-field call runs after a later argument that frees the closure (ASan heap-use-after-free). The interim E0910 stopgap (#1590) rejected the known shapes, and with them programs the language rules accept.

**Status:** FIXED 2026-10-25 (branch `fix/s1-closure-field-call-hoist`). Found while gating
`issues/fixed/2026-10-24-calling-an-fnonce-closure-is-a-false-e0910-after-the-receiver-exclusivity-extension.md`.
It is not a regression: seed v0.2.69 compiles every shape below and fails the same way. Develop after
#1573 rejected only the one-argument shape, by accident of a heuristic; the zero- and two-argument
shapes compiled and failed at run time on develop too. #1590's stopgap then rejected every
closure-field shape, but not a plain `fn`-pointer field on an `Rc` holder (`h.f(i32(1)) == eat(h)`),
which develop accepted and miscompiled the same way.

## Reproducer

`issues/repros/2026-10-24-a-dyn-closure-field-call-operand-runs-after-a-later-hoisted-argument.yo`, built with
`--std-path ./std --sanitize address --allocator system` by a compiler without the stopgap:

```yo
{ assert } :: import("std/assert");
Tok :: struct(n : i32);
Holder :: struct(cb : Dyn(Fn(x : i32) -> i32));
eat :: (fn(sink(h) : Holder) -> i32)(h.cb(i32(0)));
main :: (fn() -> unit)({
  t := Tok(n : i32(3));
  h := Holder(
    cb : dyn({ t }(x : i32) => (x + t.n))
  );
  assert(h.cb(i32(1)) == (i32(1) + eat(h)), "operand order");
  ()
});
export(main);
```

```
==…==ERROR: AddressSanitizer: heap-use-after-free … READ of size 4
```

Every one of these shapes fails the same way (`Holder` a struct with a capturing `Dyn(Fn …)` field `cb`,
`eat` taking `sink(h) : Holder`):

- the direct operand `h.cb(i32(1)) == eat(h)`, and the nested `h.cb(i32(1)) == (i32(1) + eat(h))`;
- any arity: `h.cb() == eat(h)`, `h.cb(i32(1), i32(2)) == eat(h)`;
- the borrowed-receiver form `h.mk(i32(1)).plus(eat(h))` with `mk : Dyn(Fn(x : i32) -> Sum)`;
- an `eat` that calls no closure at all (`eat` returns `h.tag`): the consuming callee does not need to
  call a `Dyn` closure.

## Root cause (from the emitted C)

`_call_may_unwind` (`src/codegen/exprs/other_fn_call.yo`) classifies every direct call through a
function-typed ATOM as may-unwind (its load-bearing atom fallback), so `eat(h)` is spilled into its own
statement followed by an `__yo_effect_escaped` check. A `Dyn(Fn)` call through a FIELD (`h.cb(x)`) has a
non-atom callee and is not classified may-unwind, so it is not spilled: it stays inline in the
comparison and runs after `eat(h)` has dropped `h` and its closure:

```c
int32_t tmp_eat = yo_id_…(__yo_v_h);               // eat(h): moves and frees h
if (__yo_effect_escaped) { return; }
bool cmp = (((__yo_v_h.__yo_v_cb).vtable->call((__yo_v_h.__yo_v_cb).data, 1)) == tmp_eat);
```

The trigger is a later sibling being spilled while an earlier one is not. With a local
`(g : Dyn(Fn(x : i32) -> i32))`, `g(i32(1)) == eat(g)` is correct only because `g(1)` is itself an atom
call, so it is spilled first and source order is kept. The general invariant that is missing: when a
later operand is spilled to a statement, every earlier operand whose value depends on state the later
one can change must be spilled before it.

## Stopgap in the evaluator (removed by the fix)

#1590 made `_is_unmarked_lent_place` (`src/evaluator/calls/function.yo`) treat a call through a
closure-valued field (a dot-step callee whose type is not `.Func`, any arity) as lending its root, so
a later argument that moved, overwrote or `&mut`-lent the holder was E0910. It rejected programs the
language accepts, and it did not cover `fn`-pointer fields.

## Fix

- **Codegen** (`generate_other_function_call`, `src/codegen/exprs/other_fn_call.yo`, the
  function-pointer / closure tail). A call through a function pointer, a `Dyn(Fn …)` vtable or a
  statically dispatched `Impl(Fn …)` capture struct now becomes its own statement,
  `T tv = <call>;`, whenever the evaluator gave it a result temp. Before, that happened only when the
  call may unwind. This is what the registered direct-call path already did, so the call runs where
  it is written, before any later sibling argument's statement. Only a may-unwind call clears and
  checks `__yo_effect_escaped`, so `_call_may_unwind`'s load-bearing atom fallback is unchanged. A call
  with no temp, whose result flows straight out, stays inline.
- **Evaluator** (`_call_lends`). The stopgap arm is gone. One case stays an error in every evaluation
  order: `h.cb(eat(h))`, where an argument of the field call consumes the field's own holder. A call
  through a closure- or fn-valued field now lends that field (`from` 0, tag `callee`) to its own
  arguments, so it is E0910, like Rust's E0505. That lend is not judged as a rule-3 lend of a
  module-level holder. Method calls (recorded callee) are excluded, and so are compile-time callees
  (`m.f`, `E.Some`).

## Tests

`tests/fn_once.test.yo` checks values, the call order and the holder's dispose count. A module-level
`g_once_order` records the order: the field call logs 1 and the consuming callee logs 2, so source
order is `12`. The tests cover:

- `h.cb1(1) < eat(h)`, the nested `h.cb1(1) < (0 + eat(h))`, `h.cb0()`, `h.cb2(0, 1)`, and an `eat`
  that only reads the tag;
- the receiver form `h.mk(1).plus(eat(h))`;
- `w.h.cb1(1) < eat(w)`, an `Rc` holder, and a generic `_OnceGen(F)` holding an `Impl(Fn)` (the static
  closure-call path);
- a `fn`-pointer field on an `Rc` holder;
- `h.cb1(eat(h))`, which is E0910 for a value holder and for an `Rc` holder.

Run with the binary before the fix (the stopgap arm removed, codegen unchanged), the four ordering
tests fail: `h.cb1(1) ran before eat(h)`, `h.mk(1) ran before eat(h)`, `w.h.cb1(1) ran before
eat(w)`, and an ASan heap-use-after-free for the `fn`-pointer field. With the fix they pass. Every
shape above, built standalone with `--sanitize address --allocator system`, runs clean.

The same change fixes a leak: a closure-field call's owned result used as a `&self` receiver was an
inline expression whose temp was never declared, so its drop was skipped
(`issues/fixed/2026-10-25-a-closure-field-call-result-used-as-a-borrowed-receiver-is-never-released.md`).

## Not fixed here (same root, different operand)

A plain earlier operand that is no call stays inline after a later argument's statement:

- `issues/2026-10-25-an-rc-field-operand-is-read-after-a-later-argument-releases-the-handle.md` (S1);
- `issues/2026-10-25-a-by-value-operand-is-read-after-a-later-mut-argument-writes-it.md` (S2).
