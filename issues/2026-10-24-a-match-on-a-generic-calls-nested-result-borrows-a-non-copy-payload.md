# A `match` on a generic call's `Result(Option(V), E)` cannot move a non-`Copy` payload out, so `HashMap(K, V).insert` rejects a `Clone`-only `V`

**Severity:** S2 — `HashMap(u64, Inner).insert(k, v)` is E0901 inside `std/collections/hash_map.yo` when `Inner` derives `Clone` without `Copy` (or has neither and no `Drop`), so such a map cannot be filled; deriving `Copy` or giving the type a `Drop` impl hides it.

**Status:** open. Found 2026-10-24 while probing `&mut` projections for VBD P3. Pre-existing: the v0.2.68 seed and the develop tree binary (`f271ed005`) report the same error.

## Reproducer

```yo
{ HashMap } :: import("std/collections/hash_map");
Inner :: struct(n : i32);
derive(Inner, Clone);
main :: (fn() -> unit)({
  mut(m) := HashMap(u64, Inner).new();
  consume(m.insert(u64(3), Inner(n : i32(10))));
});
export(main);
```

```text
error[E0901]: use of moved value: cannot copy `prev`, whose type `Option(V)` is copied only explicitly (`.clone()`), and it cannot be moved either: it is borrowed (a `&T` parameter or a `match`/`for` binding), and a borrow cannot give the value away. …
note: raised here, inside the standard library
    --> std/collections/hash_map.yo:710:20
710 |       .Ok(prev) => prev,
```

The shape without std, `issues/repros/2026-10-24-a-match-on-a-generic-calls-nested-result-borrows-a-non-copy-payload.yo`:

| scrutinee | `Inner` derives `Clone` | `Inner` has neither | `Inner` has `Drop` | `Inner` derives `Copy` |
| --- | --- | --- | --- | --- |
| `mk(v)` : `Result(Option(V), i32)`, generic `mk` | E0901 | E0901 | OK | OK |
| `mk2(v)` : `Option(V)`, generic `mk2` | OK | OK | OK | OK |
| the same two shapes from NON-generic callees | OK | OK | OK | OK |

## Analysis

The message prints the binding's type as `Option(V)`: the callee's DECLARED return type, with `V` unsubstituted, one level inside the scrutinee's type. `_decide_match_mode` (`src/evaluator/exprs/match.yo`) picks `MATCH_MODE_CONSUME` only for a value that is neither `Copy` nor "still implicitly copyable"; an abstract `V` inside the unsubstituted payload type is presumably classified as implicitly copyable, so the match borrows, and then the move of `prev` (whose type is not `Copy`) is rejected by `transfer_explicit_copy_value` (`src/evaluator/utils.yo`). A `Drop` payload is classified from the concrete type and consumes, which is why `tests/move_only_collections.test.yo`'s `_McFd` maps work. To be confirmed in the fix: where the arm binding's type stops being substituted.

## Fix plan

Decide the match mode (and type the bindings) from the instantiated scrutinee type, then add the table's E0901 rows as passing tests: a `HashMap(i32, V)` of a `Clone`-only `V` in `tests/move_only_collections.test.yo`, and the repro's `passc` shape.
