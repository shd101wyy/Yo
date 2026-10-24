# `yo fix --migrate explicit-copy` omits copies of a type without `Clone` from its listing

**Severity:** S3 — the migration's "left as written (listed above)" list is incomplete: a copy of a collection whose element type has no `Clone` is neither rewritten nor listed, so B3/B4's hand pass cannot see it and it surfaces only as E0901 at the B8 flip.

> Found 2026-10-22 by B3, the std hand pass over the explicit-copy listing
> (`feat/v2b-b3-std-explicit-copies`, plans/VALUES_BY_DEFAULT.md B3).

## Symptom

The dry run over std lists `std/fs/walker.yo:156:17` (`p`, "returned from a
borrowed binding") but not the `return(results)` two lines below it, which
returns the `&ArrayList(WalkEntry)` parameter as an owned list. Likewise
`NfaCompiler.compile` stores its `&ArrayList(GroupNameEntry)` parameter into
`self._program.group_names` (`std/regex/compiler.yo`), and nothing is listed.
`WalkEntry` and `GroupNameEntry` have no `Clone`.

## Reproducer

```yo
//! Four identical stores of a `&` collection parameter into a field; only the
//! element type differs.
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
E :: struct(name : String, depth : u32);
F :: struct(depth : u32);
Prog :: ref(struct(a : ArrayList(u32), b : ArrayList(F), c : ArrayList(E), d : ArrayList(String)));
set_a :: (fn(prog : &Prog, xs : &ArrayList(u32)) -> unit)({
  prog.a = xs;
});
set_b :: (fn(prog : &Prog, xs : &ArrayList(F)) -> unit)({
  prog.b = xs;
});
set_c :: (fn(prog : &Prog, xs : &ArrayList(E)) -> unit)({
  prog.c = xs;
});
set_d :: (fn(prog : &Prog, xs : &ArrayList(String)) -> unit)({
  prog.d = xs;
});
main :: (fn() -> unit)({
  prog := Prog(a : ArrayList(u32).new(), b : ArrayList(F).new(), c : ArrayList(E).new(), d : ArrayList(String).new());
  a := ArrayList(u32).new();
  b := ArrayList(F).new();
  c := ArrayList(E).new();
  d := ArrayList(String).new();
  set_a(&prog, &a);
  set_b(&prog, &b);
  set_c(&prog, &c);
  set_d(&prog, &d);
  a.push(u32(1));
});
export(main);
```

`yo fix ./miss.yo --migrate explicit-copy --dry-run` (develop `e30c0d8ed`)
reports `set_a` and `set_d` and says nothing about `set_b` and `set_c`:

```text
fix: ./miss.yo:9:12: `xs` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: ./miss.yo:18:12: `xs` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: would insert 0 `.clone()` call(s); 2 site(s) left as written (listed above); 0 file(s) did not evaluate
```

## Root cause

`_ic_migrate_site` (`src/evaluator/utils.yo`) returns `.None` for a copied type
that `type_lacks_clone` reports, the same answer it gives for a category that
never becomes explicit-copy. `ArrayList(F).clone` needs `F <: Clone`, so the
site is dropped before the listing step sees it. B8 still flips
`ArrayList(F)` to a unique buffer, so the copy becomes E0901 there.

## Recommendation for the fix

List such a site instead of dropping it, with its own reason ("the copied type
has no `Clone`: derive `Clone` on the element, move the value, or lend it"),
and add the four-setter program above as a `fix-migrate-explicit-copy`
cli-case whose golden shows all four lines. The listing counts in
`plans/handover/VBD_B1_EXPLICIT_COPY_LISTING_2026-10-22.md` and
`VBD_B3_STD_EXPLICIT_COPY_LISTING_2026-10-22.md` are lower bounds until then.

## Fix

Fixed 2026-10-24 with P8 (plans/handover/VBD_LOOKAHEAD_2026-10-23.md §4.4).
`_ic_migrate_site` keeps a unique-buffer copy whose type has no `Clone` and
sets `ExplicitCopySite.lacks_clone`. `_run_migrate_explicit_copy`
(`src/main.yo`) lists it after the `Clone`-impl check, ahead of every other
reason, because no other reason can make it rewritable:

```text
fix: main.yo:14:12: `xs` is copied and `ArrayList(F)` has no `Clone`, so `.clone()` cannot spell the copy; left as written (move it, borrow it, or give the type `Clone`)
```

The same change adds `StringBuilder` and `HeaderMap` to `_IC_COLLECTIONS`.
Neither has `Clone` before B11, so their copies are listed this way too.

Test: `tests/cli-cases/fix-migrate-explicit-copy-no-clone`. It holds the
four-setter program above and a `StringBuilder`/`HeaderMap` pair. With the
parameter-key fix (B4-0a) underneath, `set_a` and `set_d` are cloned (field
stores keep the automatic `.clone()`,
`issues/questions/2026-10-14-explicit-copy-migration-cannot-see-writes-through-an-escaped-copy.md`),
and `set_b`, `set_c` and both builder stores are listed.
