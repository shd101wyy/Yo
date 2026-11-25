# A typed reference local bound to a reference value crashes the member read

**Severity:** S3 (a broken diagnostic: an internal "Last expression in begin" error where a verdict belongs).

**Status:** OPEN. A fix landed on the P12 branch (2026-11-21) and was reverted there on 2026-11-24 (see "A fix that
did not hold" below). With the spelled `static` (t1 itself) the binding is now E0923 before the read is reached;
the elided and named-origin forms still fail as described. Workaround: `l.*.n`.

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

## A fix that did not hold

The P12 branch stamped the reference-binding flags (`variable_set_is_ref`) on a typed declaration whose declared slot
is a borrow and whose right-hand side is a reference read, in `evaluate_assignment`
(`src/evaluator/exprs/assignment.yo`), so that the binding would match what `m := r` produces. That is the wrong
layer:

- the flag write wraps the stored type in a reference (`_variable_resync_reference`), and the rebuilt binding at the
  end of `evaluate_assignment` wraps the right-hand side's type again when `is_ref` is set, so `l` was stored as
  `&&X`: `l.n` happened to work, and `l.*` read `&X`;
- after VERDICTS-76 (#2050, a bare `&mut` reference moves), `(a : &mut i32) = m; a.* = i32(2)` failed with E0601
  (G-B rows `v76-mut-ref-move-annotated-pos`, `-use-after-move`, `-write-while-dest-lives`); restoring the declared
  slot type after the flag write made the assignment's own compatibility check fail instead (`Expected: i32`,
  `Given: &mut i32`);
- the elided form inside a module-level function, `f :: (fn(r : &X) -> i32)({ (l : &X) = r; l.n })`, still failed
  with the original message even with the flags.

## Where the fix belongs

A typed declaration keeps the plain-variable model (the declared reference type is the binding's type, as on
develop and as VERDICTS-76's annotated move needs). The member read `l.n` on a local whose type is a reference has to
read through it, as the receiver read of a reference binding does, or report a coded error. The lookup failure is
swallowed today. That is a change to the receiver read in the property-access path, not to the binding.

## The test

When fixed: a row in `tests/local-borrows.test.yo` reading `(l : &Point) = r; l.x` in a module-level function (and
`l.*` reading `Point`), beside the existing spelled-static row (`lb_typed_static_local_from_param`, E0923).
