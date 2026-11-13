# A holder type named in a signature without its origin gets no rigid origin

**Severity:** S1. With `H :: struct(r : &Rc(X), n : i32)` (an elided `&` field), the body of
`stash :: (fn(dst : &mut Option(H), h : H) -> unit)({ dst.* = .Some(h); })` is accepted: neither `H` in the
signature carries an origin, so the store relates nothing, and `lend_through` at the caller has no origin parameter
to unify. `stash(&mut o, H(r : &y, …))` with a block-local `y` leaves `o` pointing at the dead `y` (ASan:
heap-use-after-free). Pre-existing: v0.2.76 accepts it too.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A29). Confirmed on develop `64f33c710`. The design side is
settled: this audit added the row for a nominal type's elided origin argument to O2's elision table
(`plans/backlog/REFERENCES_AND_ORIGINS.md`); see Expected.

## Reproducers

`issues/repros/2026-11-11-a-holder-type-named-in-a-signature-without-its-origin-gets-no-rigid-origin.yo`
(negative, expects E0923 in `stash`'s body):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
mk :: (fn() -> Rc(X))(Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"))));
H :: struct(r : &Rc(X), n : i32);
stash :: (fn(dst : &mut Option(H), h : H) -> unit)({
  dst.* = .Some(h);
});
main :: (fn() -> unit)({
  mut(o) := Option(H).None;
  {
    y := mk();
    stash(&mut o, H(r : &y, n : i32(0)));
  };
  match(&o, .Some(h) => println(`OUT: ${h.r.*.*.s.len().to_string()}`), .None => ());
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-field.yo` (negative, E0923): the holder nested in a field, `stash(dst : &mut W, h : H)` with
  `W :: struct(h : H, m : i32)` and the body `dst.h = h`.
- `…-pos.yo` (positive control): the signature spells one origin for both occurrences,
  `stash(generic(p : Origin), dst : &mut Option(G(p)), h : G(p))` over `G :: (fn(comptime(p) : Origin) -> …)`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `stash(dst : &mut Option(H), h : H)`, `dst.* = .Some(h)` | accepted, heap-use-after-free | E0923 in the body |
| `stash(dst : &mut W, h : H)`, `dst.h = h` | accepted, heap-use-after-free | E0923 in the body |
| `stash(dst : &mut H, src : &H)`, `dst.* = H(r : src.r, …)` | accepted, heap-use-after-free | E0923 in the body |
| the method `put(self : &mut Self, h : H)` on `W`, `w.put(H(r : &y, …))` | accepted, stack-use-after-scope | E0923 in the body |
| the generic `put(generic(T : Type), dst : &mut T, v : T)` at `T := H` | E0911 at the caller | E0911 |
| std `swap(&mut h1, &mut h2)` over two `H`s or two `Option(&Rc(X))` | E0911 at the caller | E0911 |
| the elided `dst : &mut &Rc(X), v : &Rc(X)` with `dst.* = v` | E0923 in the body | E0923 |

The method row also needs `lend_through` at dot calls (it returns early there, the fix lane `o6-method-lend`); the
body check this issue asks for rejects it independently of the caller.

## Root cause

Hypothesis, consistent with the source. O-3 (`BORROW_CHECKER_COMPLETENESS.md` §8, landed 2026-11-08) gives "every
elided `&` written in a parameter type" a fresh rigid origin. The rigid-origin pass walks the `&` TOKENS of a
signature; `H` and `Option(H)` contain none, and `H`'s field origin is a hidden parameter of its definition that the
signature leaves unbound. The body's `=` join (`bind_join`, `src/evaluator/utils.yo`) checks a subset only when
`origin_param_names_of` finds spelled names on the holder's type; with none on either side the store is a plain
flow join on the parameter, which judges nothing. At the caller, `lend_through`'s step 1 finds no origin parameter
through `dst`'s pointee and step 3's write-back finds no other argument naming one, so `o` is never widened by
`&y`. The generic `T := H` form is caught because a type parameter carries one origin into all its occurrences
(O-3, VERDICTS-37) and step 3 matches it by type variable.

## Expected

E0923 in `stash`'s body: "a fresh anonymous origin per OCCURRENCE of the type name, rigid in the body …
(Rust's `H<'_>`)" — O2's elision-table row for "a nominal type's origin argument, the type named in a signature",
added by this audit. `dst`'s `H` and `h`'s `H` are two unrelated origins, and storing one into the other is the same
E0923 the elided `dst : &mut &Rc(X), v : &Rc(X)` already gets. The repair is to spell one shared origin
(`G(p)` in both positions, the positive control), and then `lend_through` unifies `p` at the caller (O3-3) and
widens `o` by `y`: E0911 at the read after `y`'s block.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`elided-holder-param-store` (E0923), `elided-holder-field-store` (E0923) and `spelled-holder-param-store` (accept).

## Fix (2026-11-13, lane `sig`, branch `fix/sig-1`)

Two gaps, both closed:

1. **The rigid binder skipped the nominal's hidden origin.** `nominal_has_hidden_origin` (`src/types/utils.yo`)
   answers whether a struct or enum carries an origin that none of its type arguments supplies (an elided `&` field
   of its definition, directly or through a field of another such nominal; a generic holder `V(T) :: struct(xs : &T)`
   included). `_rigidify_elided_origins` (`src/evaluator/utils.yo`) then gives each OCCURRENCE of such a type in a
   parameter one more fresh rigid origin, as if `H(h#v1)` had been written (O2's nominal row). Only the origin walks
   read the rigid slot.
2. **A by-value parameter's origins never reached the store check.** `origin_of` gives a by-value parameter no root,
   so even spelled origins compared nothing: `dst : &mut Option(&(X, q)), o : Option(&(X, p))` with `dst.* = o` was
   accepted. `byvalue_param_origin_names` collects the declared (rigid when elided) origins of every by-value
   parameter a stored value holds, and `bind_join` / `place_write_join` check them against the holder's names
   (`_byvalue_param_subset_check`), with the rigid-origin E0923 and its shared-origin repair.

A field type that is one of the nominal's type arguments is read as that argument (an instance's fields are its
definition's with the arguments substituted), so `Pair(T) :: struct(a : T, r : &i32)` at `T := &i32` is read as
having no hidden origin: its hidden `r` is missed. No such type exists in std or src.

The G-B rows (`tests/origins/unsound/`): `elided-holder-param-store`, `elided-holder-field-store`,
`elided-holder-method-store`, `elided-holder-copy-through-ref`, `elided-holder-generic-store` (E0923), with the
positive controls `elided-holder-param-store-pos` (the spelled `G(p)` form) and `elided-holder-method-store-pos`.
