# A value nested deeper than 8 aggregate levels is never torn down

**Severity:** S1 — a value nested 9 or more aggregate levels deep was silently never torn down: its `drop` never ran and its counted cells leaked; a deep tuple was also wrongly rejected with E0901

**Found 2026-08-08** (TS-era wording then: "yo-self" is today's compiler).
**Re-triaged 2026-10-23** on develop `5136a2b9d` and with the v0.2.68 seed:
still reproduced. **Fixed 2026-10-23** on `fix/s1-rc-depth-cap`.

## Symptom

A value whose counted cell or `Drop` leaf sits 9 or more aggregate levels down
was never torn down. The same value 8 levels down was torn down correctly.

Reproducer: [`issues/repros/rc-depth-cap-skips-deep-teardown.yo`](../repros/rc-depth-cap-skips-deep-teardown.yo)
(ported from `Dispose` to `Drop`). Before the fix it printed `disposed=7` (the
depth-8 control) and never `disposed=42` (depth 10). Both runs exit 0.

The 2026-10-23 sweep put one `ref` with `Drop` under `d` wrapper levels,
compiled at `-O2`, and counted `disposed=` lines. It used a develop binary
built from `6dee22187`, whose `src/` equals develop's:

| shape                                   | d ≤ 8 | d = 9 … 40                                                   |
| --------------------------------------- | ----- | ------------------------------------------------------------ |
| struct chain                            | 1     | 0 (leak)                                                     |
| single-payload enum chain               | 1     | 0                                                            |
| `Option(Option(…))`                     | 1     | 0                                                            |
| nested tuple `((T, i32), i32)…`         | 1     | compile error: spurious E0901 ("cannot copy … it is borrowed from the value that holds it") |
| value type with `Drop` in plain structs | 1     | 0 (the user destructor is skipped, not just a refcount)      |
| `Box(Box(…))`, `ArrayList(ArrayList(…))`, a struct/enum/Option/Box mix | 1 | 1 (each `Box`/`ArrayList` node answers before the cap) |

ASan/LSan (`--sanitize address --allocator system`), struct chain: `d = 8` is
clean, while `d = 9` and `d = 40` report `SUMMARY: AddressSanitizer: 12 byte(s)
leaked in 1 allocation(s)`. The emitted C at `d = 9` has no `__yo_decr_rc` for
the local at all, on the normal path or the early-return path.

## Root cause

The type walks in `src/types/utils.yo` that ask "does this type hold a counted
cell or a move-only value" stopped at a fixed depth and answered `false` past
it:

```yo ignore
_type_contains_rc_inner :: (fn(ty_in : &TypeValue, depth : u32, flip : bool) -> bool)({
  ty := resolve_enum_shell(resolve_struct_shell(ty_in));
  cond(
    // Depth limit — conservative: return false at max depth
    (depth > u32(8)) => false,
```

The cap stood in for a cycle guard (the TS compiler used an identity
`checkedTypes` set). But it also fired on ordinary nesting with no cycle, and
its answer there, "contains nothing to drop", was wrong.

How the drop was lost on develop (the 2026-08 "dup emitted, drop not" account
was out of date by then):

- The evaluator kept the variable in its drop list.
  `get_variables_needing_drop` (`src/env.yo`) asks `type_contains_rc_type`, the
  `flip` variant, and decision 36's flip makes the outer non-`Copy` struct
  answer `true` at depth 0.
- Codegen then dropped nothing. `generate_drop_code_for_value`
  (`src/codegen/exprs/drop_dup.yo`) returns an empty string when
  `type_contains_rc_cell_or_move_only` (the non-flip variant) is false. That
  walk reached the `ref` or `Drop` leaf at depth 9, and the cap answered
  `false`. The per-field recursion further down restarts the predicate at
  depth 0 for each field, so only the top-level call tripped the cap.
- The tuple E0901 had the same cause. The deep tuple temp did not count as
  owning, because the non-flip predicate was capped, and it was not `Copy`
  either, so the borrow/move check rejected it.

Three sibling walks carried the same cap and gave the same wrong answer on
deep nesting:

- `_type_is_move_only_inner`: a `Drop` value 9+ levels down was not move-only.
- `_reaches_non_atomic_cell_inner`: used by Box tracing and the `Acyclic`
  derivation.
- `_type_is_control_bound_inner`: a `ctl` value 9+ levels down escaped the
  frame-bound checks. On 2026-08-08 its cap fired 181 million times in one
  self-compile, re-walking nine levels of a self-referential type each time.

`_move_only_reason_inner`, which writes the E0901 note's text, had the cap
too.

## Fix

No walk answers by depth any more. `_TypeWalk` (`src/types/utils.yo`) holds the
state of one top-level predicate call. It works by object identity, as
`_type_repr_contains_raw_ptr` already did
(`issues/fixed/defining-a-deep-struct-dag-is-exponential.md`):

- `path`: the aggregates on the current path. Reaching the same object again
  is a cycle and answers `false` there, which is what a cycle contributes to
  an "any component" walk.
- `memo`: the answers of the aggregates already walked, so a sub-graph shared
  by several fields is walked once.
- `cut`: a `false` computed under a cycle cut depends on the path and is not
  memoized. A `true` is exact either way.

The walk keys on identity rather than id because substituted generic
instantiations share ids (`src/types/intern.yo`): an id-keyed set would cut
`Option(Option(T))`. Below depth 8 (`_TYPE_WALK_TRACK_DEPTH`) nothing is
tracked and nothing allocated, so the common shallow walk costs what it did.
A cycle is still caught one turn after the walk crosses that depth. Depth 1024
(`_TYPE_WALK_MAX_DEPTH`) remains only as a stack backstop that marks the walk
cut. No well-formed type reaches it without a cycle.

These walks now take a `_TypeWalk`: `type_contains_rc_type` and
`type_contains_rc_cell_or_move_only`, `type_is_move_only`,
`type_reaches_non_atomic_cell` and `type_is_control_bound`.
`move_only_reason` descends only into a component that `type_is_move_only`
accepts, so it follows one path to the declaring type at any depth.

## Verification

- `tests/rc.test.yo` gains eleven cases, each holding one `Drop` value under
  N wrapper levels and checking it is dropped exactly once: struct chains at
  9, 16 and 40 levels, enum chains at 9 and 16, `Option` at 10, a value type
  with `Drop` at 12, a tuple at 9, struct and tuple mixed at 40, and a
  recursive enum and a generic recursive enum (both through `Box(Self)`) held
  12 levels deep. On the develop binary the cases' batch fails to compile
  (the 9-level tuple's E0901); with the two tuple cases left out, the other
  nine all fail at run time. On the fixed binary all 130 tests in the file
  pass.
- The depth sweep (struct, enum, `Option`, tuple, `Box`, mix, `ArrayList`;
  d = 1, 7, 8, 9, 10, 12, 16, 24, 40) drops the value exactly once in all 61
  programs that compile. The two that do not, `Option` at 24 and 40, ran past
  the sweep's 300 s limit in `check` on both binaries; that is
  `issues/2026-10-23-nested-option-type-check-is-exponential.md`, a separate
  issue. ASan/LSan is clean for the struct chain at 9 and 40, the tuple, enum
  and mixed chains at 40.
- Emit-diff, develop binary against the fixed one (same `YO_STD`): the C for
  `src/main.yo` is byte-identical, and so is the C of every batch of
  `tests/rc.test.yo` (develop's copy), `type_soundness`, `thread`,
  `move_only`, `copy_trait`, `send_sync`, `thread_safety` and
  `algebraic_effects`. The C of the new deep cases differs only by added
  teardown: the deep field-path drops and the enum drop helpers of the deep
  chains.
- The work ratchet's method (stage-2 C at `--optimize 2`, rebuilt by clang on
  glibc malloc, `check src/main.yo` under the `alloc_count.c` shim, ASLR off):
  develop `5136a2b9d` counts 1,983,264,366 allocation calls, this branch on
  it 2,003,464,618 (+1.0%, inside the ±5% ratchet).
