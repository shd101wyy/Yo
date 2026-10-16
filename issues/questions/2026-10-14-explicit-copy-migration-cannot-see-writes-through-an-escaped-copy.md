# How should `yo fix --migrate explicit-copy` treat a copy that escapes the function?

**Kind:** design question: an open decision, not a defect. Filed 2026-10-14
with the migration (`plans/VALUES_BY_DEFAULT.md`, V2b "Unique buffers",
Generation A2; `_run_migrate_explicit_copy`, `src/main.yo`).

## The question

Before V2b's flip, a copy of a `String` or a collection shares its buffer
with its source. The migration writes `.clone()` at each such copy whose
source is used again, so after the flip the copy is independent. That changes
what the program does exactly where one side is written while the other is
read again. Sometimes the program relied on the sharing:

```yo
l := m(k);
l.push(x); // meant to grow the list inside the map
```

The migration sees writes inside the function that makes the copy: a store
into a field or element of the source or of the destination variable, a
`&mut` argument or receiver the callee may write (its mutation mask), and a
`&mut` borrow. It lists such a site and leaves it alone. A copy that leaves
the function is out of its sight:

```yo
items :: (fn(self : &Bag) -> ArrayList(i32))(self.items);
// a caller:
b.items().push(i32(1)); // meant to grow b's list; after the migration it grows a clone
```

The same holds for a copy stored in a field or passed by value to a callee
that writes it. What should the migration do with these escaping copies
(`return`, `field-store`, `element`, `param`)?

## Options

1. **Insert, and print every escaping insertion under `--dry-run`** (as
   built). The review list is the safeguard. The flip itself cannot catch a
   wrong one: after `.clone()` the program compiles and quietly does
   something else.
2. **List every escaping copy and insert none.** Each becomes a hand edit:
   a projection (`-> &mut ArrayList(i32)`, decision 24), an `Rc`, or a
   `.clone()`. That is safe but large: §6's sample found escaping paths in
   most `src/` sites (2,461 returns or block tails and 2,441 field stores of
   6,551).
3. **Make the flip find them.** Run the migration only on `binding`/`assign`
   paths and let the flip's E0901 errors name the escaping copies one by one,
   with the compiler's note offering `.clone()` or a borrow.

## Recommendation

Option 1, with option 3's split for `return`. Since V2a, a list that two
places hold on purpose is an explicit handle ("Shared on purpose" in §6
V2a), and the V2a audit drove collection writes through borrowed places from
957 to 20. So an escaping copy that is then written is rare by construction.
A `return` of a borrowed field is the one shape that is a classic accessor,
though. Leave `return` copies of a `&`-borrowed root out of the automatic
insertion and let the flip's E0901 name them. A hand edit there is usually
a projection, not a clone. Field stores and by-value arguments keep the
automatic `.clone()` and the dry-run review list.

## Status

2026-10-17: the recommendation's `return` split is implemented on
`feat/v2b-genb-b1-migration` (step B1 of `plans/VALUES_BY_DEFAULT.md`'s
Generation B sequence), pending the maintainer's verdict on that plan. A
`return` copy of a place rooted in a `&T` or a `&mut T` parameter
(`ExplicitCopySite.src_borrow`, `src/evaluator/utils.yo`) is listed, not
rewritten; field stores, elements and by-value arguments keep the automatic
`.clone()`. The `&mut` root is included because a `return` of a field of a
`&mut self` receiver is the same accessor shape, whose hand edit is a
`-> &mut T` projection. The fixture is `tests/cli-cases/fix-migrate-explicit-copy`.
