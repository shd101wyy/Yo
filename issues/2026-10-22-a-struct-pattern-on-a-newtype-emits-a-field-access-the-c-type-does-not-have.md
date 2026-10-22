# A struct pattern on a newtype emits a field access the C type does not have

**Severity:** S2 — a valid program fails at the C compiler. A `match` arm
that destructures a `newtype` by its field (`W(_b : b) => b`) is lowered to
`self._b`, but a newtype's C representation is its field's type, which has
no member `_b`.

**Status:** open. **Found:** 2026-10-22 by the V2b B8 flip probe
(`plans/handover/VBD_B8_PROBE_CENSUS_2026-10-22.md`). Once `String` is
`newtype(_bytes : ArrayList(u8))`, `String.into_bytes(sink(self))` has to move
`_bytes` out of `self`, and the struct pattern is the only spelling that the
evaluator accepts:
- `self._bytes` is "a field of another value" (no partial moves);
- `{ _bytes } := self` binds a borrow
  (`issues/2026-10-22-a-whole-value-destructuring-binds-move-only-fields-as-borrows.md`).

With the pattern, every `tests/string/string.test.yo` batch that reaches
`into_bytes` fails to compile, under the v0.2.68 seed and under develop
`e30c0d8ed` alike:

```text
tests/string/.yo_selftest_batch_76400_1_2.bin.c:21262:56: error: no member named '_bytes' in 'struct __yo_t_15456947660178909902_struct'
 21262 |     __yo_t_15456947660178909902 __yo_v_b = __yo_v_self._bytes;
```

## Reproducer

`issues/repros/2026-10-22-a-struct-pattern-on-a-newtype-emits-a-field-access-the-c-type-does-not-have.yo`
(develop's std, no flip needed):

```yo
{ println } :: import("std/fmt");
B :: struct(n : i32);
impl(B, Drop(drop : (fn(self : &mut Self) -> unit)(println("drop B"))));
W :: newtype(_b : B);
impl(
  W,
  into_b : (fn(sink(self) : Self) -> B)(
    match(self, W(_b : b) => b)
  )
);
main :: (fn() -> unit)({
  w := W(_b : B(n : i32(4)));
  b := w.into_b();
  println(&b.n);
});
export(main);
```

```text
np.c:2262:55: error: no member named '_b' in 'struct __yo_t_5390551108033029306_struct'
```

The same pattern on a `struct(...)` (not a newtype) compiles and runs.

## Root cause (hypothesis)

The match lowering (`src/codegen/exprs/match.yo`) renders a struct pattern's
field binding as `<scrutinee>.<field>` without consulting whether the
scrutinee's type is a newtype, whose C type is its field's type. Elsewhere a
newtype's field read goes through the newtype erasure, so the `.field` is
dropped.

## Fix direction

When the pattern's struct is a newtype, bind the field to the scrutinee
itself. The regression test is the repro above, which should print `4`, then
`drop B`.

## Why it matters for the release plan

The seed compiles std at CI's stage 1. Until a seed carries the fix,
`String.into_bytes` cannot move its buffer out after B8 and has to clone it,
which breaks the documented "moves when unique" contract.
