# `bench(name, 0, body)` hands back `min_ns = i64::MAX` and `max_ns = 0`

**Found**: 2026-09-04, by the std-API audit re-measurement of the
`std/testing/bench` row. **Class**: wrong value on a public std API — the
returned `BenchResult` violates the `min_ns <= max_ns` invariant that the
module's own coverage test asserts, and `to_string()` prints the raw sentinel
to the user. **Status**: OPEN.

## Reproducer

```rust
open(import("std/fmt"));
open(import("std/string"));
{ bench } :: import("std/testing/bench");
main :: (fn() -> unit)({
  r := bench(String.from("zero"), u64(0), () => ());
  println(r.to_string());
  println(`min_ns=${r.min_ns} max_ns=${r.max_ns} min>max=${r.min_ns > r.max_ns}`);
});
export(main);
```

```
$ yo compile r0.yo --optimize 2 -o r0.out && ./r0.out
bench 'zero': iters=0 avg_ns=0 min=9223372036854775807 max=0
min_ns=9223372036854775807 max_ns=0 min>max=true
```

Expected: a zero-iteration run measures nothing, so it must not report a
timing range at all — either it is rejected (see **Fix**), or every field is
`0` and `min_ns <= max_ns` holds. `9223372036854775807` is an internal
sentinel and must never reach a caller.

## Root cause

`std/testing/bench.yo:71-107` seeds the running extrema with sentinels and
then builds the result unconditionally:

- `:73` `min_ns := i64(9223372036854775807); // i64::MAX`
- `:74` `max_ns := i64(0);`
- `:76` `while(i < iterations, …)` — the body that would replace both
  sentinels never executes when `iterations == u64(0)`
- `:95-98` `avg_ns` is the **only** field with a zero guard
  (`cond((iterations > u64(0)) => (total_ns / i64(iterations)), true => i64(0))`)
- `:99-106` `BenchResult(… min_ns : min_ns, max_ns : max_ns)` is constructed
  on every path

So the author saw the divide-by-zero and guarded it, and missed that the two
extrema carry the same "no sample yet" problem. `to_string`
(`std/testing/bench.yo:52-63`) then renders `min_ns` verbatim, which is where
the `9223372036854775807` in the output above comes from.

## Why the test suite never saw it

`bench` has exactly one consumer in the tree:
`tests/std_export_coverage.test.yo:150-161`, and it always passes `u64(25)`:

```rust
r := bench(String.from("coverage"), u64(25), () => { count.push(i32(1)); });
…
assert(r.min_ns <= r.max_ns, "min <= max");
```

That assertion is precisely the invariant this bug breaks — it just is never
handed the input that breaks it.

## Fix

A benchmark of zero iterations has no answer, and inventing one is what
produces the bad value. Two directions:

1. **Recommended — reject it.** Guard at the top of `bench`
   (`std/testing/bench.yo:72`) with
   `cond((iterations == u64(0)) => __yo_panic("bench: iterations must be >= 1"), true => ())`.
   This matches how std already reports caller contract violations
   (`std/collections/array_list.yo:58`, `:134` — `__yo_panic("ArrayList.with_capacity: capacity overflow")`),
   and it keeps `BenchResult` honest: every field it carries is a real
   measurement. It does not change any signature.
2. **Fallback — return an all-zero result.** Extend the `iterations > 0`
   guard at `:95-98` to `min_ns` and `max_ns` so a zero-iteration run reports
   `total=avg=min=max=0`. Cheaper to test, but `avg_ns=0, min=0, max=0` is
   then indistinguishable from a genuine sub-nanosecond measurement, which is
   the reason to prefer (1).

Do **not** change the return type to `Option(BenchResult)`/`Result` — that is
a breaking signature change for a value nothing in the tree constructs
defensively, and it buys nothing over (1).

Whichever is chosen, apply the same rule to any budget-driven successor
(`bench_auto`) added by the audit's `std/testing/bench` row: a zero budget is
the same input class.

## Related: `std/testing/bench.yo` carries no `## Stability` marker

`grep -rn '## Stability' std/` finds only `std/term.yo:6`,
`std/encoding/csv.yo:20`, `std/http/server.yo:18` and `std/fs/watch.yo:28`.
Under the freeze mechanics an unmarked module counts stable and
additive-only, so `bench` is on paper frozen even though it has zero
consumers outside the one coverage test. Adding
`//! ## Stability` / `//! unstable — …` to `std/testing/bench.yo` belongs in
the same PR; it is what makes the reshape the audit wants (batched timing,
percentiles) non-breaking later.

## Regression test

`tests/std_export_coverage.test.yo`, next to the existing `test("bench", …)`
block at `:150-161`:

- for fix (2): a `test("bench with zero iterations", …)` asserting
  `r.iterations == u64(0)`, `r.total_ns == i64(0)`, `r.avg_ns == i64(0)`,
  `r.min_ns == i64(0)`, `r.max_ns == i64(0)` and `r.min_ns <= r.max_ns`;
- for fix (1): the suite has no expect-panic facility, so pin it with a CLI
  case instead — `tests/cli-cases/bench-zero-iterations/` modelled on
  `tests/cli-cases/contracts-runtime-requires/` (`cmd` = `build run`,
  `expected_rc` = 1 (`build run` propagates a panic as rc=1 — see that case's `opts`), `opts` carrying
  `stdout_keep_match=bench: iterations must be >= 1`). Run `yo fmt` on the
  fixture before recording the golden with `bash scripts/cli-diff-test.sh --record`
  — the CI fmt gate scans `tests/cli-cases` and the tree hash is baked into
  `expected_tree`.

Either way the test must be verified RED against today's `bench` before the
fix lands.
