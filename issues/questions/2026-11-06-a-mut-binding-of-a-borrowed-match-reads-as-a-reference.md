# A `mut(name)` binding of a borrowed `match` is a copy, but it reads as a reference

**Kind:** design question — an open decision, not a defect.

**Status:** OPEN. Filed 2026-11-06 with
`issues/fixed/2026-11-06-a-mut-binding-of-a-borrowed-match-writes-through-the-shared-reference.md`,
which made the binding a copy again and left its typing as it was before #1795.

## What is inconsistent

In a `&` match (`match(&x, …)`, or a reference binding matched bare), a binding is a reference
into the scrutinee's place (decision 43, VERDICTS-13 §14). A `mut(name)` binding is not: it
binds BY VALUE, a copy of its part, as Rust 2021's `mut` resets the default binding mode.

The deref rule still reads the copy as a reference (`is_borrow_match_binding`, so its stored
type is `&T`). That has three effects:

- A whole-value read or write needs `.*`, although no reference exists: `x.* == 1`, and
  `x = 10` is E0926 ("`x` is a reference (`&i32`): writing the value it refers to is spelled
  `x.* = …`").
- `x.* = …` in a `match(&e, .Two(mut(x), _) => …)` is then E0908 "`x` is a `&` borrow, which is
  read-only". So the `mut` marker grants nothing in a `&` match: the copy cannot be written.
- Under a reference binding matched bare (`r := &o; match(r, .Some(mut(d)) => d.n = 7)`), a field
  write into the copy IS accepted and changes only the copy. The same marker therefore means
  different things under the two spellings of a borrowed scrutinee.

```yo ignore
e := _Two.Two(x : i32(1), y : i32(2));
match(&e, .Two(mut(x), y) => {
  x = i32(10);       // E0926: spelled `x.* = …`
  x.* = i32(10);     // E0908: `x` is a `&` borrow, which is read-only
}, _ => ());
```

## Options

1. **Rust's reading.** A `mut(name)` binding of a `&` match is a by-value binding of type `T`.
   It is read and written without `.*`, it is reassignable, and only it changes. A move-only `T`
   is E0901: Rust's "cannot move out of a shared reference" (`mut d` over a `String` is
   rejected). A `Copy` `T` is a plain copy. This needs `is_borrow_match_binding` to stay unset
   on the binding, and a migration for the `x.*` reads the deref rule asked for.
2. **Reject the marker.** `mut(name)` in a `&` match is an error with a repair: "bind it and
   copy it: `.Some(d) => { mut(c) := d.*; … }`". This is the explicit-copy spelling the
   explicit-copy rules already prefer for a part that is not `Copy`.
3. **Keep today's behavior**: the copy reads as `&T`, and the marker is accepted but unusable
   under `match(&x, …)`.

## Recommendation

Option 1, Rust's reading. The binding IS a value copy at runtime, so typing it `T` makes the
deref rule describe what the program does. It makes the two spellings of a borrowed scrutinee
mean the same thing, and it matches the Rust 2021 default binding modes that VERDICTS-13 §14
adopted for the non-`mut` bindings.

The move-only case must be E0901, never a bitwise copy whose drop would release the owner's
data. That is the hazard the regression above was about, and E0908 guards it today.

Option 2 is the fallback if a by-value binding of a borrowed part is judged too implicit for
LLM-written Yo.
