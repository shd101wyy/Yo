# A holder's read ignores what its assignments joined, and a by-value parameter reads as its own place

**Severity:** S2. Valid programs are rejected: a holder that `=` filled from a parameter cannot be returned (E0912
"holding `res`"), and neither can a copy of a by-value parameter holder.

Found 2026-11-09 while fixing
`issues/fixed/2026-11-08-a-match-binding-of-a-reference-payload-carries-its-own-place-as-origin.md`: with that fix,
std's `IterFilter.next` and `Iterator.find` stopped at E0923 and then failed at E0912 on their `return`. Present on
develop ee24d9058.

## Reproducer

```yo
keep :: (fn(generic(p : Origin), r : &(i32, p)) -> Option(&(i32, p)))({
  mut(res) := Option(&(i32, p)).None;
  res = .Some(r);
  res // E0912: "Cannot return a value holding `res`"
});
copy :: (fn(generic(p : Origin), o : Option(&(i32, p))) -> Option(&(i32, p)))({
  c := o;
  c // E0912: "Cannot return the local borrow `c`: it borrows `o`"
});
```

## Root cause

- **The joins are not read.** `origin_of`'s R-READ on a holder atom returns the holder's registered entries
  (`_holder_roots_into`), and those cover only `g_local_borrows`, `bind`'s run. What its `=` assignments joined (O-1)
  lives in `g_local_borrow_joins`, which only the access checks scanned. `keep`'s `res` was bound to `.None` and so
  had no entries. R-READ fell back to the holder's own place, which is a local, so the return check rejected it.
- **A by-value parameter is not a reference.** The same fallback pushes a parameter's own place. For a reference
  parameter `r : &T` that place stands for the caller's referent. A by-value holder `o : Option(&(T, p))` holds the
  caller's references, so its own place is no root of its value, and `c := o` made `c` "borrow `o`".

## Fix

- `_holder_roots_into` adds the holder's live join entries, matched by name and module, to its `bind` entries. The
  joins table lives for the function body.
- R-READ's own-place fallback skips a by-value parameter. A lend of it (`&o`) is R-LEND's and keeps its place, and a
  reassignment of it is a join that the previous change now reads.

## Tests that pin it

- `tests/local_borrows.test.yo`:
  - `_keep_joined`, `_keep_typed` and `_copy_param` are accepted and run.
  - `_return_joined_local`, which returns a local's lend joined into the holder, is still E0912.
