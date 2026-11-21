# A typed reference local bound to a reference value crashes the member read

**Severity:** S3 (a broken diagnostic: an internal "Last expression in begin" error where a verdict belongs).

**Status:** OPEN, filed 2026-11-21 by the P12 lane (VERDICTS-74 §"To file", probe t1).

## The repro (t1)

```yo
pragma(Pragma.AllowUnsafe);
X :: struct(n : i32);
f :: (fn(r : &X) -> i32)({
  (l : &(X, static)) = r;
  l.n
});
main :: (fn() -> unit)(());
export(main);
```

`yo check` (the v0.2.79 seed and the integration binary of 2026-11-21 agree):

```text
error: Last expression in "begin" is not evaluated correctly:
(l.n)
```

and with the read off the tail, `n2 := l.n;` fails with `Failed to evaluate, got (l.n)`: the member read never
receives an ExprInfo. `l.*.n` on the same binding evaluates, so does `m := r; m.n`, and `l.len()` reports
`No method "len" on &X` — the auto-dereference a flow-inferred binding's receiver read performs is skipped for a
local declared `(l : &X)`/`(l : &(X, o))` and bound to a reference VALUE (not a place lend), and the field-lookup
failure is then swallowed instead of reported.

The crash is not specific to `static`: `(l : &(X, r)) = r; l.n` (a named origin) and `(l : &X) = r; l.n` (elided, a
safe file) fail identically.

## The fix

(filled in by the fixing PR)

## The test

(filled in by the fixing PR)
