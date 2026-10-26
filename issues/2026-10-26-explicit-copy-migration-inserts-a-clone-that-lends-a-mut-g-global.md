# The explicit-copy migration inserts a `.clone()` that lends a `mut(G)` global (E0916)

Found during the B4-3c directory sweep (2026-10-26), `src/evaluator/utils.yo:7361`
(`g_lb_lookahead_stmts`, an `ArrayList(AstExpr)` whose element's `Clone` is
hand-written in `src/expr.yo`).

**Severity:** S3 — a hand fix (stage the read through a local) unblocks every affected
insertion; the tool keeps producing the illegal spelling until fixed.

## The defect

`yo fix --migrate explicit-copy` inserts `.clone()` at a copy site whose source is a
module-level binding declared `mut(G)` (decision 47's reassignment case). Calling
`.clone()` on such a binding LENDS it to the method (`self : &Self`). The global-lend
gate exempts a *structural* `clone()` (derived, or the impl lives in std:
`_is_structural_clone_call`, `src/evaluator/calls/function.yo`), but a list whose
element type's `Clone` is hand-written outside std is NOT structural, and the lend is
rejected: a mutable module-level binding has no run-time borrow flag.

The site (as the tool rewrote it):

```yo ignore
stmts := g_lb_lookahead_stmts.clone();
```

```text
error[E0916]: Cannot lend `g_lb_lookahead_stmts` to `g_lb_lookahead_stmts.clone`
(the receiver of a `self : &Self` method): `g_lb_lookahead_stmts` is declared
`mut(g_lb_lookahead_stmts)`, a mutable module-level binding, which has no run-time
borrow flag. (plans/VALUES_BY_DEFAULT.md decision 18 rule 3, decision 47).
```

## Reproducer

`issues/repros/2026-10-26-explicit-copy-migration-inserts-a-clone-that-lends-a-mut-g-global.yo`
(element `Clone` hand-written, so the structural exemption does not apply):

```yo ignore
xs := g_xs;              // check: evaluator OK
```

- `yo check <repro> --std-path ./std` — passes.
- `yo fix <repro> --migrate explicit-copy --std-path ./std` — "inserted 1 `.clone()`
  call(s)", rewriting the read into `xs := g_xs.clone();`.
- `yo check <repro> --std-path ./std` — **fails E0916**: the migration produced code
  that does not compile.

## The hand fix (applied in B4-3c)

Stage the read through a local, then clone the local (a read by name is decision 47's
reassignment case and stays legal):

```yo ignore
(cur_lb_stmts : ArrayList(AstExpr)) = g_lb_lookahead_stmts;
stmts := cur_lb_stmts.clone();
```

## The tool fix (not in B4-3c — the fix logic lives in `src/main.yo`, B4-1a's scope)

The insertion pass should stage a `mut(G)`-rooted source through a fresh local (a read
by name) and insert the `.clone()` on that local, or list the site for a hand edit
instead of inserting. Affected insertions in the 2026-10-26 B4-3c sweep: 1
(`utils.yo:7361`); the other B4 directory PRs re-run their dry runs and will surface
any others.
