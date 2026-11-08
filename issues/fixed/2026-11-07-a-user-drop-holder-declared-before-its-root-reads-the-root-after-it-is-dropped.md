# A user-`Drop` holder in a slot declared before its root reads the root in `drop` after the root's drop

**Severity:** S1 — use-after-free inside a user `Drop` impl in safe code

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-user-drop-holder-declared-before-its-root-reads-the-root-after-it-is-dropped.yo`.

`yo check` accepts it ("evaluator OK", tree binary at develop `8d475cd81` and later); compiled with `--sanitize address --allocator system` and run, ASan reports `heap-use-after-free` inside `drop`.

## Root cause

The holder's live range ends at its last use, not at its scope-end drop, for a type that reaches a user `Drop` (`REFERENCES_AND_ORIGINS.md` O3, "Drops that use no root", is unbuilt), so reverse-declaration drop order frees the root first.

## Fix

O-4 (`Drop`-extended liveness), v0.2.77 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

corpus row `drop-holder-before-root`; the repro under `tests/origins/unsound/`.

## Resolution (O-4, 2026-11-08)

Since O-3 (#1836) the reproducer above is rejected for another reason: `h`'s
type spells `Option(H(x))`, and re-pointing it at `y` is E0923 (a spelled
holder points only into its origin). The hole itself stayed reachable through
a holder whose origin is flow-inferred, and through a move of the root. Each
of these shapes was accepted on develop `68d531aec` and fails under ASan:

- `h6b`: a `G(&Rc(X))` holder with a concrete user `Drop` that reads through
  `t`, declared before `y` and re-pointed at it (heap-use-after-free);
- `h6c`: the same holder re-pointed at a root of an inner block
  (stack-use-after-scope);
- `h6d`: `h := H(y)(r : &y); sink(y);`. The holder's last use is its
  declaration, so moving `y` out passed, and `h`'s `drop` read the freed `y`
  (heap-use-after-free).

The fix is O-4, `Drop`-extended liveness. D1's criterion is
`type_reaches_user_drop` (`src/types/utils.yo`): the holder's type reaches,
through fields, payloads, elements and type arguments, a nominal whose `Drop`
uses its roots (`nominal_drop_uses_roots`, `src/evaluator/values/impl.yo`).
Any impl outside std counts. A std impl counts only on a type with an origin
argument of its own, because std's buffer containers are `may_dangle`.

A holder of such a type is live to its scope-end drop, through `bind` and the
`=` join (`local_borrow_range_of(…, to_scope_end)`). From that:

- moving or writing the root while the holder lives is the ordinary E0911;
- an inner-block root is the §7 scope check, E0911;
- a root declared after the holder in the same block is E0911 at the store,
  because bindings drop in reverse declaration order.

Tests: `tests/origins/unsound/h6b-*`, `h6c-*` and `h6d-*` (each with its
positive twin), and the corpus row `drop-holder-before-root` with its model
verdict.
