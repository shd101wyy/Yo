# ArrayList `.get`/`.last` over a user-struct element mistypes the accessed field

**Severity:** S3 — valid code is rejected at `check` with a confusing
`No method "<m>" on (x.a)` error; found 2026-10-01 while writing the
regression canary for
`issues/fixed/derive-clone-over-an-arraylist-field-emits-a-hollow-clone.md`
(the canary's element-value asserts had to be dropped for it).

## Reproduction

`issues/repros/arraylist-last-user-struct-element.yo`:

```rust
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
I :: struct(a : usize);
main :: (fn() -> unit)({
  l := ArrayList(I).new();
  l.push(I(a : usize(1)));
  x := l.last();            // .get(usize(0)) behaves identically
  println(x.a.to_string()); // ← E0610 here
  ()
});
export(main);
```

```
error[E0610]: No method "to_string" on (x.a): the type has no field or
method with that name.
  --> …:9:15
```

## What the controls say

- `ArrayList(i32).last()` → the result types fine (methods on it resolve):
  the element being a **user-defined struct** is the discriminator, not
  `last`/`get` themselves.
- Reaching the list through a struct FIELD changes nothing —
  `h.rel.last()` fails the same way as `l.last()`.
- The failure is at the FIELD ACCESS on the result (`x.a`), whose type
  comes out as something no method resolves on — the parenthesized
  `(x.a)` in the message is the rendered node, and the real defect is
  whatever type the element-typed return of the generic `get`/`last`
  specialization recorded for `x`.
- Inside a test batch the same shape surfaced as
  `check_if_function_parameter_matches_argument: arg has no ExprInfo`
  (the value passed onward from the mistyped access carries no info) —
  same root, different symptom.

## Fix direction

Compare the recorded ExprInfo type of the `last()`/`get()` result over
`ArrayList(I)` (I a user struct) against `ArrayList(i32)` — the
specialization's return re-evaluation over a user-struct element type is
the suspect (`YO_DEBUG_RRE=1` prints the re-evaluation). This blocks
nothing structurally: bind the element first (`e := l.last(); e.a`) — no,
that IS the failing form; only extracting through a second local typed by
the compiler differently (e.g. `usize` results) works around it.
