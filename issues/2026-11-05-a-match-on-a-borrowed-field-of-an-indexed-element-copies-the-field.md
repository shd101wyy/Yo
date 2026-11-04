# `match(&xs(i).f, …)` copies the field instead of borrowing it

**Severity:** S2 — a valid program is rejected with E0901. `match(&xs(i), …)` reads an element in place, but `match(&xs(i).f, …)` copies the field first, so a move-only field cannot be matched through an indexed element. The workaround is to match the element and then its field (`match(&xs(i), r => match(&r.f, …))`) or to borrow-iterate.

Found 2026-11-05 by V5 part B (`src/main.yo`'s verify self-test once `VerifyResult` became a value). Reproduces with the v0.2.74 seed and with a stage-1 compiler built from develop `95209c9b5`.

## Reproducer

`issues/repros/2026-11-05-a-match-on-a-borrowed-field-of-an-indexed-element-copies-the-field.yo`:

```yo ignore
Verdict :: enum(Proved(names : ArrayList(String)), Refuted);
Res :: struct(verdict : Verdict);
// accepted: the element is matched in place, then its field
(a : bool) = match(&xs(usize(0)), r => match(&r.verdict, .Proved(_) => true, _ => false));
// rejected
(b : bool) = match(&xs(usize(0)).verdict, .Proved(_) => true, _ => false);
```

```
error[E0901]: use of moved value: cannot copy `xs(usize(0)).verdict`, whose type `Verdict` is move-only, and it cannot be moved either: it is a field of another value, and moving it out would leave that value partly moved (Yo has no partial moves). Move the whole value instead.
   --> idx2.yo:12:35
```

The same happens when `xs` is a `&ArrayList(Res)` parameter.

## Expected

`&xs(i).f` is a place: element `i`'s field `f`. Lending it reads in place, the same as `&xs(i)` and `&s.f` do (Rust: `match &xs[i].f { … }`). The place walk that makes `&xs(i)` a lend (`plans/VALUES_BY_DEFAULT.md` "Projections are places for the markers", ~L5928) stops at the index and does not follow a field projection on top of it.

## Status

Open. The test (both forms accepted, and `b` evaluates like `a`) lands with the fix.
