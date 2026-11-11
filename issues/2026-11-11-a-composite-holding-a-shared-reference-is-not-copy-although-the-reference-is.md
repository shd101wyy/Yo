# A composite holding a shared reference is not `Copy` although the reference is

**Severity:** S2. Valid programs are rejected: `slot := Option(&i32).Some(&b); a := slot; c := slot;` is E0901
"use of moved value: `slot`", and so is matching an `Option(&String)` twice or copying a `(&i32, &i32)` tuple.
`&T` is `Copy` and the prelude has `impl(where(T <: Copy), Option(T), Copy())`, so the copies should be legal.
The workaround is re-borrowing at each use. Pre-existing: v0.2.76 rejects all three reproducers with the same
E0901.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 C1). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-composite-holding-a-shared-reference-is-not-copy-although-the-reference-is.yo`
(`// expect: accept`):

```yo
main :: (fn() -> unit)({
  b := i32(4);
  slot := Option(&i32).Some(&b);
  a := slot;
  c := slot;
  match(a, .Some(r) => println(`OUT: ${r.*.to_string()}`), .None => ());
  match(c, .Some(r) => println(`OUT: ${r.*.to_string()}`), .None => ());
  ()
});
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76:
error[E0901]: use of moved value: `slot`
  --> repro.yo:9:8
```

- `…-string.yo` (`// expect: accept`): `slot := Option(&String).Some(&b)` matched twice; E0901 at the second
  `match`.
- `…-tuple.yo` (`// expect: accept`): `t := (&b, &b); a := t; c := t;`; E0901 "cannot copy `t`, whose type
  `Tuple(0 : &i32, 1 : &i32)` is move-only (it is neither `Copy` nor `Clone`)".

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `a := slot; c := slot;`, `slot : Option(&i32)` or `Option(&String)` | E0901 | accept |
| `match(slot, …)` twice, `slot : Option(&String)` (direct, from `slot = .Some(&b)`, or from a `match(&b, …)` arm: ledger cp01–cp03) | E0901 | accept |
| `_ := slot.is_some(); match(slot, …); _ := slot.is_some();` | E0901 | accept |
| `t := (&b, &b); a := t; c := t;` | E0901 "neither `Copy` nor `Clone`" | accept |
| an `Option(&T)` slot read on every loop iteration and re-assigned in the body (ledger l07g, l08c) | E0901 "moved inside the loop" | E0911 (the slot holds a reference to a per-iteration local) |
| `slot : Option(i32)` matched twice | accepted | accept |

## Root cause

Confirmed by reading `src/evaluator/trait_checking.yo` (not traced in a debugger). The move check consults `Copy`
correctly: `type_requires_explicit_copy` → `_plain_data_lacks_copy` (`src/types/utils.yo`) → the installed
`type_lacks_copy_for_flip`. That function answers a TOP-LEVEL reference itself (`if(t_slot_is_borrow(&ty),
return(t_slot_is_mut_ref(&ty)))`: `&T` copies, `&mut T` does not). Any other type goes to `type_implements_trait(ty, Copy)`. For `Option(&i32)` that finds the prelude's conditional impl and
must discharge `T <: Copy` with `T = &i32`. But `type_implements_trait` has no case for `&T`: its structural `Copy`
path (`copy_structural_parts`) covers tuples, arrays, `fn` pointers, records and capture records, and no impl can
name a reference. The answer is "not `Copy`", so `Option(&i32)` is not `Copy` either; a tuple's parts recurse into
the same function. The structural fact "`&T` is `Copy`" is written in two special cases, the flip's top-level test
and the `derive(Copy)` field check (`Rc(.Reference(_, false, _)) => part_is_copy = true`, "A `&` reference is
`Copy` structurally (decision 43 step 3, §5 route 3)"), but not in the trait query the where-clause bound uses.

## Expected

Accepted. `plans/VALUES_BY_DEFAULT.md` decision 43: "`&T` is `Copy`. `&mut T` is not"; `plans/backlog/REFERENCES_AND_ORIGINS.md`
route 3: "copies carry identical origins (all-`&` values are `Copy`)". The fix belongs in `type_implements_trait`
(`&T <: Copy` and `&T <: Clone` hold structurally, `&mut T` never), so a generic bound `where(T <: Copy)`
instantiated at `T = &U` holds too; the two special cases then become redundant.

## Test

With the fix: the three programs as cases of `tests/copy_trait.test.yo` (`Option(&T)`, `Option(&String)` matched
twice, a tuple of references), plus a negative twin with `Option(&mut i32)` (E0901 stays) and a corpus row
`copy-option-of-shared-ref` (accept) in `tests/origins/corpus.tsv`.
