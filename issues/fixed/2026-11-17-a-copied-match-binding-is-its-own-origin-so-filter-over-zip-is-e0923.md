# A copied `match` binding is its own origin, so `filter` over `zip`/`enumerate` of borrowed cursors is E0923 inside std

**Severity:** S2 — a valid program was rejected with an error raised inside the standard library:
`(&xs).into_iter().zip((&ys).into_iter()).filter(…)` and `(&xs).into_iter().enumerate().filter(…)` failed to compile,
and so did `tests/for_read_walk.test.yo`, on develop `916b279c1` and `b2155b8bf`.

**Status:** FIXED on `fix/develop-v0279-reds`.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");
main :: (fn() -> unit)({
  mut(xs) := ArrayList(String).new();
  xs.push(String.from("alpha"));
  mut(ys) := ArrayList(String).new();
  ys.push(String.from("gamma"));
  n := (&xs).into_iter().zip((&ys).into_iter()).filter(p => (p.*._0.*.len() == p.*._1.*.len())).count();
});
export(main);
```

```text
error[E0923]: Cannot assign a value holding origin `item` to `loop_result`: its type is declared over `Option(IterPair(A, B))`, whose origin does not name `item`, and a holder points only into the places its origin lists (decision 43, plans/backlog/REFERENCES_AND_ORIGINS.md O3).
note: raised here, inside the standard library
      --> std/prelude.yo:11407:31
11407 |                 loop_result = .Some(item);
```

`filter` over a plain `(&xs).into_iter()` compiles. So do `zip(...).count()` and `filter` over owned elements.

## Root cause

`IterFilter.next` (`std/prelude.yo`) reads:

```yo ignore
candidate := self._inner.next();
match(candidate, .None => { break; }, .Some(item) => {
  cond((self._f)(&item) => { loop_result = .Some(item); break; }, true => ());
});
```

At `A := IterPair(&String, &String)` (zip) or `IterPair(usize, &String)` (enumerate), `A` is `Copy`, so
`_decide_match_mode` takes the match as decision 26's "copies or shares" row (`MATCH_MODE_BORROW` without `ref_binds`).
The binding `item` is a by-value copy of the payload: not a reference binding, not consumed, and not a `bind`-registered
holder. `origin_of(item)` (R-READ / R-COPY in `_origin_of_into`) found no holder entries and fell back to the binding's
own place. The `=` join (`bind_join` → `_bind_join_subset_check`) then saw a value holding the local `item`, which the
holder's spelled origin does not name, and raised E0923. A consuming match does not have this problem: C13
(`note_ref_payload_held` in `exprs/match.yo`) records that a moved part holds what the scrutinee held, and the copy row
had no equivalent.

The program is fine. Rust accepts the same body: `let mut r: Option<A> = None; … Some(item) => r = Some(item)` with
`A: Copy` holding references; the copy carries `A`'s lifetimes, not a borrow of `item`. The checker was too strict; the
std code is right.

## Fix

`src/evaluator/exprs/match.yo`: a by-value binding of a copying match records what the scrutinee held
(`note_ref_payload_held(…, origin_held_by(scrutinee))`), as C13 does for a consuming match. That covers a binding that
is not a reference payload, a `mut` place, a `ref_binds` borrow or a static `str` view, and whose type carries an
origin. `origin_of(item)` is then the scrutinee's roots, never `item`'s own place.

## Verification

The reproducer compiles. `tests/for_read_walk.test.yo` failed to compile on `b2155b8bf` (0 of 9 ran) and passes 9/9
with the fix.
