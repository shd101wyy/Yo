# A `Drop` running inside the live range of a `mut(G)` lend is not a call for decision 18 rule 3

**Severity:** S2. While `y := &G` is live, an explicit call is E0911, but a destructor that runs at an inner block's
end or at a reassignment is not counted: its `Drop` writes `G`, and two reads through the same live `&` return
different values (`before=1 after=101`). No memory error with a scalar global; with an owning payload the same gap
is only reachable today through a `match(y, …)` arm binding, the separately filed arm-binding hole (ledger
B-F2). Pre-existing: v0.2.76 accepts both reproducers and rejects the explicit call.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A44). Confirmed on develop `64f33c710`. Sibling:
`issues/2026-11-11-the-d1-thread-reach-walk-does-not-see-drop-so-a-value-dropped-on-another-thread-races-on-a-global.md`
(A41, the same blind spot in the thread reach walk).

## Reproducers

`issues/repros/2026-11-11-a-drop-running-inside-the-live-range-of-a-mutg-lend-is-not-a-call-for-decision-18-rule-3.yo`
(negative, expects E0911):

```yo
{ println } :: import("std/fmt");
mut(G) := i64(1);
_bump :: (fn() -> unit)({
  G = (G + i64(100));
});
D :: struct(n : i64);
impl(D, Drop(drop : (fn(self : &mut Self) -> unit)(_bump())));
main :: (fn() -> unit)({
  y := &G;
  w := y.*;
  {
    d := D(n : i64(1));
    _ := d.n;
  };
  v := y.*;
  println(`OUT: before=${w.to_string()} after=${v.to_string()} (expect equal)`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
OUT: before=1 after=101 (expect equal)
```

- `…-reassign.yo` (negative, E0911): `mut(d) := D(n : i64(1)); d = D(n : i64(2));` inside the range; the old
  value's `Drop` runs at the reassignment: `before=1 after=101`.
- `…-call.yo` (control, E0911 today and on v0.2.76): the same write spelled `_bump();` inside the range.
- `…-pos.yo` (positive control): the block with `d` comes after `y`'s last use: `before=1 after=1`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| a `Drop` at an inner block's end inside `y := &G`'s range | accepted, value changes under `&` | E0911 |
| a reassignment of a `Drop` local inside the range | accepted, value changes under `&` | E0911 |
| `_bump()` (the same write as a call) inside the range | E0911 | E0911 |
| a `Drop` after the lend's last use | accepted | accept |
| `match(y, .Some(s) => { {d}; s.clone() })`, `G : Option(String)`, the `Drop` sets `G = .None` (ledger, base) | accepted, reads the released `String` (`OUT:` empty) | E0911 (also ledger B-F2) |
| `y := &G.*` over `mut(G) := Box.new(…)` (ledger, base) | rejected ("cannot reach through a pointer dereference") | — |

## Root cause

Confirmed by reading the source. Rule 3 is enforced by `local_borrow_note_call` (`src/evaluator/utils.yo`), which
raises E0911 for each live module-rooted borrow. Its only caller is `local_borrow_note_runtime_call`, reached from
`_local_borrow_note_call_site` (`src/evaluator/calls/function.yo`), which runs at a CALL expression (skipping
scalar operators). Drop glue is not a call expression: scope-end drops and the drop of a reassigned binding's old
value are emitted by codegen, so the evaluator never presents them to the rule. The same AST-only view causes A41.

## Expected

Decision 18 rule 3 (`plans/VALUES_BY_DEFAULT.md`): "A module-level root has no cell. A local borrow of one is
rejected if its live range contains a call or an `await`", amended by decision 47 so that only a `mut(G)` root is
affected. A destructor is a call: the evaluator knows, at a scope end and at a reassignment, which values with a
`Drop` impl (directly or through their fields) are destroyed there, and each such point inside the live range of a
`mut(G)` lend must be judged as a call (E0911, naming the dropped binding and its `Drop` impl). The rule's own
reason applies unchanged: "a callee can reach a module-level place by name". A finer rule — only a `Drop` whose
reach (the D1-style walk) includes `G` — is a possible refinement; the plain reading counts every user `Drop`.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`, and
`tests/global_lend.test.yo` (which pins rule 3's E0911 text) gains the block-end and reassignment `Drop` forms
beside the explicit-call case.
