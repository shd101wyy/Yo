# A `Dyn(Fn)` field call used as an operand runs after a later argument's hoisted call (use after free)

**Severity:** S1 — memory unsafety in accepted safe code: the earlier operand's closure call runs after a later argument frees the closure (ASan heap-use-after-free).

**Status:** open. Found while gating
`issues/fixed/2026-10-24-calling-an-fnonce-closure-is-a-false-e0910-after-the-receiver-exclusivity-extension.md`.
It is not a regression: seed v0.2.69 compiles the program and fails the same way. Between #1573 and
that fix, develop rejected it with a false E0910, which hid the bug.

## Reproducer

`issues/repros/2026-10-24-a-dyn-closure-field-call-operand-runs-after-a-later-hoisted-argument.yo`, built with
`--std-path ./std --sanitize address --allocator system`:

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

## Root cause (from the emitted C)

`eat(h)` may unwind, because it calls a `Dyn` closure. Codegen therefore hoists it into its own
statement, followed by an `__yo_effect_escaped` check. The left operand `h.cb(i32(1))` is not hoisted.
It stays inline in the comparison, so it runs after `eat(h)` has dropped `h` and its closure:

```c
int32_t tmp_eat = yo_id_…(__yo_v_h);               // eat(h): moves and frees h
if (__yo_effect_escaped) { return; }
bool cmp = (((__yo_v_h.__yo_v_cb).vtable->call((__yo_v_h.__yo_v_cb).data, 1)) == (1 + tmp_eat));
```

The same shape with a local `(g : Dyn(Fn(x : i32) -> i32))`, `g(i32(1)) == (i32(1) + eat(g))`, is
correct. There the call `g(1)` is classified as may-unwind, so it is hoisted first and the source
order is kept. A call through a closure-typed FIELD (`h.cb(x)`) misses that classification. The bug
is therefore in how a field's `Dyn(Fn*)` call is classified for hoisting and effects. A related
question: whether any un-hoisted earlier operand with effects must be spilled whenever a later sibling
is hoisted.

## Test to add with the fix

Add a runtime test to `tests/fn_once.test.yo` (or `tests/dyn.test.yo`): a struct with a
`Dyn(Fn(x : i32) -> i32)` field, with `h.cb(i32(1)) == (i32(1) + eat(h))`, checking dispose counts
under ASan.
