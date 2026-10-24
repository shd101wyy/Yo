# A `Dyn(Fn)` field call used as an operand runs after a later argument's hoisted call (use after free)

**Severity:** S1 — miscompile of evaluation order: an earlier operand's closure-field call runs after a later argument that frees the closure (ASan heap-use-after-free). The evaluator now rejects the known shapes with an E0910 stopgap, which in turn rejects programs the language rules accept.

**Status:** open (codegen). Found while gating
`issues/fixed/2026-10-24-calling-an-fnonce-closure-is-a-false-e0910-after-the-receiver-exclusivity-extension.md`.
It is not a regression: seed v0.2.69 compiles every shape below and fails the same way. Develop after
#1573 rejected only the one-argument shape, by accident of a heuristic; the zero- and two-argument
shapes compiled and failed at run time on develop too.

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

## Stopgap in the evaluator

`_is_unmarked_lent_place` (`src/evaluator/calls/function.yo`) treats a call through a closure-valued
field (a dot-step callee whose type is not `.Func`, any arity) as lending its root, so a later argument
that moves, overwrites or `&mut`-lends the holder is E0910. Tests: "FnOnce: a closure-field call as an
operand or receiver lends the holder" in `tests/fn_once.test.yo`.

## Fix and test to add

Fix the codegen ordering (spill the earlier operand, or classify a closure-field call like an atom
closure call), then drop the stopgap arm and turn that test into runtime tests of the five shapes above
under ASan, checking dispose counts.
