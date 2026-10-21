# The explicit-copy dying-temporary guard calls a copy through a dereference a move

**Severity:** S3. No wrong code: `yo fix --migrate explicit-copy` lists a genuine copy as "usually a move" instead of cloning it, so the migration misses a `.clone()` the seed inserts, and the listing's advice is false.

**Status:** FIXED on `feat/explicit-copy-guards` before it merged. Found
2026-10-21 by the adversarial review of the branch's dying-temporary guard
(`issues/fixed/2026-10-20-explicit-copy-migration-clones-a-copy-out-of-a-dying-temporary.md`).

## Symptom

```yo
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
Holder :: struct(name : String, tags : ArrayList(String));
make :: (fn() -> Holder)(Holder(name : String.from("m"), tags : ArrayList(String).new()));
Shelf :: struct(h : Rc(Holder));
grab :: (fn(s : &Shelf) -> Rc(Holder))(s.h);
main :: (fn() -> unit)({
  s := Shelf(h : rc(make()));
  a := grab(&s).*.name;
  b := s.h.*.name;
  println(`${a} ${b} ${s.h.*.name}`);
});
export(main);
```

`yo fix r.yo --migrate explicit-copy --dry-run`, branch tree binary before
the fix:

```text
fix: r.yo:10:8: `((grab(&(s)).(*)).name)` is a field of a temporary that dies after the copy, so the copy is usually a move; left as written (spell `.clone()` by hand if the value is read again)
fix: r.yo:11:8: binding: `(((s.h).(*)).name)` would become `s.h.*.name.clone()`
```

The v0.2.67 seed rewrites both lines. What dies at the end of line 10 is the
`Rc(Holder)` handle `grab` returned; its pointee is still owned by `s.h`,
which line 12 reads, so the copy is real.

## Root cause

`_ic_dying_temp_source` (`src/evaluator/utils.yo`) follows `.` receivers
until it reaches an owning temporary. A dereference `p.*` parses as the same
two-argument `.` form, so the walk stepped through `grab(&s).*` to the
handle `grab(&s)` and judged the field dying with it.

## Fix

The walk stops with "not dying" at a dereference (`_is_deref_place`): the
copy reads storage the handle only points to, which an `Rc`/`Arc` pointee or
a pointer's target outlives. A `Box` pointee does die with its handle, but
it is not told apart; the old rule (a `.clone()`) is never wrong there, only
wasted.

## Test

`tests/cli-cases/fix-migrate-explicit-copy-dying-temp` gained
`e := grab(&s).*.name` with the pointee read again; its goldens expect the
`.clone()` rewrite (the summary's insertion count goes from 1 to 2, and
`expected_tree` pins the rewritten file). Before the fix the same case
listed it as a field of a dying temporary. A `--dry-run` of the fixture with
the fixed tree binary prints
`fix: main.yo:28:8: binding: ... would become grab(&s).*.name.clone()`.
