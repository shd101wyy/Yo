# A borrowed `for` over a `&mut` param is E0926 when the fn also takes an `Impl(Fn)` param

**Severity:** S1 — a legal fn shape is unwritable (every spelling of the loop is
rejected), and it blocks `check ./src` (85 of 274 files fail through
`src/evaluator/shared/suspension_analysis.yo:668`) under N3's deref adoption
(v0.2.76 hard-gate lane `vbd/deref-adoption`). G1's ~35 `&mut Impl(FnMut(...))`
slot switches will meet the same rejection at scale.

Filed 2026-11-06 on `vbd/deref-adoption` (f47ff53df), reproduced with the
T_del2 binary (the branch's `1d0b723df` build; any tree binary carrying the
`is_deref_rule_exempt` deletion).

## Verbatim error

```
error[E0926]: `m` is a reference (`&mut ArrayList(String)`): borrowing the value it refers to is spelled `&m.*`
   --> tmp/dfor10.yo:10:10
10 |   for(&m.*, k => {
   |          ^
help: write `&m.*` (or `&mut m.*`), or pass `m` itself to a reference parameter
```

The site IS spelled `&m.*` — the diagnostic demands what is already written.

## Minimal reproducer

```yo ignore
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string/string");
walk10 :: (
  fn(
    m : &mut ArrayList(String),
    g : &Impl(Fn(x : &i32) -> i32)
  ) -> usize
)({
  mut(n) := usize(0);
  for(&m.*, k => {
    n = (n + usize(1));
  });
  n
});
idc :: (fn(x : &i32) -> i32)(x.*);
caller10 :: (fn(h : &mut ArrayList(String)) -> usize)(walk10(h, idc));
export(caller10);
```

`yo check` of that file fails. Remove EITHER the `g` param OR replace the loop
(`m.clone()` value form) and it passes.

## The shape is unwritable — every spelling rejected

With an `Impl`-typed parameter present (either `&Impl(Fn(...))` or
`&mut Impl(FnMut(...))`), a borrowed `for` over another `&mut` param fails in
every spelling (all probe-verified on T_del2, files `tmp/dfor10..17.yo`):

- `for(&m.*, ...)` — E0926 (the false positive; `&mut m.*` identical).
- `for(&m, ...)` — E0926 (this one correctly rejected).
- `for(m, ...)` (bare scrutinee) — E0901 (copy of the move-only referent).
- explicit capture list on the loop closure — E0901 ("cannot copy `m`").

Without the `Impl` param the first spelling is accepted everywhere
(`tmp/dfor1..9.yo`): plain fn params, value or `&mut`-param callers, generic
instantiation, recursion, both elements used, two same-typed map params. The
trigger is solely the `Impl(Fn)`/`Impl(FnMut)` parameter's presence; parameter
order is irrelevant, `ArrayList` and `HashMap` both fire, and `std` never hits
it only because no std fn yet combines an `Impl` slot with a borrowed `for`
over another parameter (which is exactly what G1's slot switches create).

## Blast radius

- `src/evaluator/shared/suspension_analysis.yo:668`
  (`walk_expr_` — `get_info : &Impl(Fn(e : &AstExpr) -> Option(ExprInfo))` is
  its second parameter; the `for(&name_frame_to_original_id.*, ...)` snapshot
  loop is its one borrowed `for`): every `check ./src` entry file that imports
  it — 85 of 274 — reports the E0926. Verified by bisection: reducing
  `walk_expr_` to the two-param `(expr, name_frame_to_original_id)` signature
  with the identical loop passes; adding `get_info` back fails.
- The compiler's own `analyze_suspension_points` path (async/effect suspension
  analysis) is un-type-checkable until this is fixed or worked around.

## Mechanism (as far as pinned)

The rejection anchors at the token of the spelled `*` (col 10 above is the `*`
of `&m.*`, and in `suspension_analysis.yo` the span starts at the last
character of the identifier, covering `.*, (k, v) => {`). `make_deref_expr`
(`src/evaluator/exprs/property_access.yo:245`) synthesizes `.(obj, *)` nodes
whose tokens copy the written access's position, and `_is_written_star` /
`is_synthesized_deref_star` distinguish them from written stars. With the
`Impl` param present, the for-desugar's loop (the `_fd_*` forms,
`src/expr.yo:_desugar_for_call`) or the loop closure's Fn-slot judgment walks
the scrutinee through a synthesized star, and the kind-2 `&v` rejection
(`reject_reference_without_deref`, callers at
`src/evaluator/exprs/initialization_assignment.yo:357`,
`src/evaluator/values/anonymous_function.yo:1000`,
`src/evaluator/calls/type.yo:334`) judges the borrow as bare — the written
`.*` hop does not count on that path. The exact firing site was not pinned
without a debug build; the three kind-2 callers above are the candidates.

## Fix direction

Whichever call site fires, a synthesized deref star anchored at a written
`.*`'s position must count as the written deref for the kind-2 exemption (the
written-star note is `note_reference_deref_site`; the synthesized-star registry
is `note_synthesized_deref_star`), or the desugar must keep the written node on
that path. The failing test below turns green with either.

## Test

The test lands with the fix (a red test cannot sit in the suite while the bug
is open — it fails the whole batch): `tests/borrow_spelling.test.yo` grows
`test("a borrowed for over a &mut param beside an Impl Fn param reads it", …)`
— the reproducer above, asserting the loop counts both elements — which fails
today with the E0926 above and passes once the judgment counts the written
deref. Until then `src/evaluator/shared/suspension_analysis.yo` carries the
clone-snapshot workaround marked with this issue's path.
