# An assignment judges its write before its RHS

**Severity:** S3 — `cur = f(&cur)`-shaped code is falsely rejected with E0911
whenever the RHS's read of a reference is that reference's last use; the
workaround is one extra line, and one `src/` site carries it.

**Status:** open. **Found:** 2026-11-14, as the "design signal inside src" of
the arms lane's cluster-3 audit (branch `fix/c3-value-origins`, its PR body);
the hoisted-reference shape below was re-probed the same day on the installed
seed (`yo` v0.2.77) and on a develop-built stage-1 binary — both reject it.

## Reproducer

No standalone failing test is added with this doc: the natural test is a
positive program that must compile, so it would redden the suite until the fix
lands; it belongs with the fix. The shape (probe, seed and develop-built binary
both rc=1):

```yo
C :: struct(n : i32);
clone_c :: (fn(c : &C) -> C)(C(n : c.n));
main :: (fn() -> unit)({
  (mut(cur) : C) = C(n : i32(1));
  r := &cur;
  cur = clone_c(r);
});
export(main);
```

```text
error[E0911]: Cannot write `cur` here: `r` borrows `cur` with `&` and is still live, and a `&`
borrow freezes its place: while it is live, `cur`, the places inside it and the places containing
it are not written or moved.
  note: and is used again here, so it is live at the access:
    cur = clone_c(r);
```

The liveness note points inside the same statement's RHS: the read that would
end `r`'s loan and the write that must wait for it are one assignment, and the
write is judged first. The inline spelling `cur = clone_c(&cur);` is accepted
(rc=0 on both binaries — the borrow is a temporary of the call), so the false
rejection bites exactly when the reference outlives its own statement up to
the assignment: a hoisted local reference, or a match arm binding that lends
the scrutinee.

## Root cause

The assignment rule (`src/evaluator/exprs/assignment.yo`) judges the write to
the place before the RHS's reads, so a loan over the place that the RHS itself
ends — the reference's last use — is still live at the write. In the arms
lane's words: "A3's new loan meets the existing rule that an assignment judges
its write before its RHS." The proper fix is to judge the RHS's reads first,
as Rust's two-phase evaluation does.

## Workaround

Bind the RHS into a fresh local first — `next := clone_c(r); cur = next;`
(rc=0 on both binaries). The site the arms lane had to respell is
`src/types/utils.yo` `future_unreturnable_borrow` (~line 587): with A3 making
a match arm's bindings lend the scrutinee, `cur = Rc.clone(r)` inside the
`match(&cur, Rc(.SomeT(...)))` walk became `next := Rc.clone(r); cur = next;`
on `fix/c3-value-origins`. Develop tip still carries the direct spelling,
which compiles there only because the arm bindings do not lend yet.
