# std's `Ord`-bounded algorithms compare with `<` and never call `cmp`, so a NaN misorders a sort and aliases a `BTreeMap` key

**Severity:** S2 — `ArrayList(f64).sort()` leaves a number after the NaNs, `BTreeMap(f64, V).insert(NaN, v)` overwrites another key's value and a `PriorityQueue(f64)` pops NaNs in the middle; the type's documented total `cmp` (D3.3) would order all three.

**Found:** 2026-11-26, VERDICTS-87 (the operator-trait naming consult), probes `e1`, `e2`, `e3`.
**Measured:** `yo 0.2.79` built from develop (`~/Workspace/Yo-wt/v0280-p12/yo-out/x86_64-unknown-linux-gnu/bin/yo`), `--std-path` of develop `030d63040`, compiled with `--optimize 1`.

## Symptom

`Ord(Rhs)` carries Rust's `PartialOrd` operators plus a `cmp` that is contractually total; the float impls override `cmp` so a NaN equals a NaN and is greater than every number (D3.3, 2026-08-23). `nan.cmp(1)` is `Greater` and `nan.cmp(nan)` is `Equal` as documented, but std's generic algorithms never call it.

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array-list");

main :: (fn() -> unit)({
  z := f64(0.0);
  nan := (z / z);
  one := f64(1.0);
  println(`nan == nan: ${(nan == nan)}; nan != nan: ${(nan != nan)}; nan < 1: ${(nan < one)}; nan > 1: ${(nan > one)}`);
  o := nan.cmp(&one);
  p := one.cmp(&nan);
  q := nan.cmp(&nan);
  println(
    `nan.cmp(1): ${match(o, .Less => "Less", .Equal => "Equal", .Greater => "Greater")}; 1.cmp(nan): ${match(p, .Less => "Less", .Equal => "Equal", .Greater => "Greater")}; nan.cmp(nan): ${match(q, .Less => "Less", .Equal => "Equal", .Greater => "Greater")}`
  );
  mut(xs) := ArrayList(f64).from([f64(3.0), nan, f64(1.0), f64(2.0), nan, f64(0.5)]);
  xs.sort();
  (mut(i) : usize) = usize(0);
  while(i < xs.len(), {
    println(`${xs(i)}`);
    i = (i + usize(1));
  });
});
export(main);
```

```text
nan == nan: false; nan != nan: true; nan < 1: false; nan > 1: false
nan.cmp(1): Greater; 1.cmp(nan): Less; nan.cmp(nan): Equal
1
2
3
NaN
NaN
0.5
```

`sort` is not sorted: `0.5` comes after both NaNs. Two more programs, same binary:

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
{ BTreeMap } :: import("std/collections/btree-map");

main :: (fn() -> unit)({
  z := f64(0.0);
  nan := (z / z);
  mut(m) := BTreeMap(f64, i32).new();
  m.insert(f64(2.0), i32(2));
  m.insert(nan, i32(9));
  m.insert(f64(1.0), i32(1));
  m.insert(nan, i32(8));
  m.insert(f64(3.0), i32(3));
  println(`len ${m.len()} has1 ${m.contains_key(&f64(1.0))} has2 ${m.contains_key(&f64(2.0))} has3 ${m.contains_key(&f64(3.0))} hasnan ${m.contains_key(&nan)}`);
});
export(main);
```

```text
len 3 has1 true has2 true has3 true hasnan true
```

Five inserts of four distinct keys (`2.0`, NaN, `1.0`, NaN, `3.0`) leave `len` 3: `_find` sees "neither `<` nor `>`" for a NaN against any stored key, takes it as equal, and the second NaN overwrites the entry the first one found.

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
{ PriorityQueue } :: import("std/collections/priority-queue");

main :: (fn() -> unit)({
  z := f64(0.0);
  nan := (z / z);
  mut(q) := PriorityQueue(f64).new();
  q.push(f64(2.0));
  q.push(nan);
  q.push(f64(5.0));
  q.push(f64(1.0));
  q.push(nan);
  q.push(f64(4.0));
  mut(i) := i32(0);
  while(i < i32(6), {
    match(q.pop(), .Some(v) => println(`${v}`), .None => ());
    i = (i + i32(1));
  });
});
export(main);
```

```text
5
4
NaN
2
1
NaN
```

A max-heap under `cmp` pops `NaN NaN 5 4 2 1`.

## Root cause

Every `Ord`-bounded consumer in std writes the operators and none calls `cmp`:

- `ArrayList.sort` and `sort_unstable`: `(a, b) => (a.* < b.*)` (`std/collections/array-list.yo`, ~1648 and ~1662);
- `sort_by_key`: `key(a) < key(b)` (~1895);
- `binary_search`, `Iterator.min`/`max`, `BTreeMap._find` (`self._entries(mid).key < k.*`, `> k.*`) and the `PriorityQueue` sift (`std/collections/priority-queue.yo`, `>` at ~122 and ~128).

`.cmp(` appears once in non-test std outside the prelude (`std/net/addr.yo`). Under `where(T <: Ord(T))` the operator `<` is the type's own and is IEEE on floats; only `cmp` is total. The trait's contract was never applied by the code that depends on it.

## Fix

VERDICTS-87 PR B (`plans/backlog/STD_RUST_ALIGNMENT.md` §9): std only. Every `Ord`-bounded algorithm calls `cmp`; the `Ord` doc comment states the rule "code that needs a total order calls `cmp`; the operators are the type's own and are partial on floats". An integer's default `cmp` is `<` then `==`, so a `cmp`-based sort does up to two comparisons where it did one; not timed.

## Test to add with the fix

In the collection tests (`tests/collections/array-list.test.yo`, `tests/collections/btree-map.test.yo`, `tests/collections/priority-queue.test.yo`): a NaN row for each algorithm. `sort`/`sort_unstable` of `[3, NaN, 1, 2, NaN, 0.5]` is `0.5 1 2 3 NaN NaN`; a `BTreeMap(f64, i32)` with two NaN inserts holds one NaN key and `len` equals the number of distinct keys under `cmp`; a `PriorityQueue(f64)` pops the NaNs first; `binary_search` and `min`/`max` agree. Each fails before the fix.

## Fixed (2026-11-26, VERDICTS-87 PR B)

std only. Every `Ord`-bounded algorithm orders by `cmp`: `ArrayList.sort`, `sort_unstable`, `sort_by_key` and `binary_search` (`std/collections/array-list.yo`), `BTreeMap._find` (`std/collections/btree-map.yo`), the `PriorityQueue` sift up and down (`std/collections/priority-queue.yo`), and `Iterator.min`/`max` (`std/prelude.yo`). The std impls over another `Ord` type now build `cmp` from the parts' `cmp` instead of inheriting the operator-derived default, which is not total on floats: `Reverse(T)` (the documented min-heap idiom), `Option(T)`, `Result(T, E)`, `Array(T, U)`, and `derive(Ord(…))` on structs and enums. `longdouble` gains the total `cmp` override `f32` and `f64` already had. The `Ord` doc comment and the docs' Rust-names row state the rule: code that needs a total order calls `cmp`; the operators are the type's own and are partial on floats.

The three programs above now print `0.5 1 2 3 NaN NaN`; `len 4` with the NaN key holding `8`; and `NaN NaN 5 4 2 1`.

Tests (each fails on develop's std): `tests/collections/array-list.test.yo` (`sort`, `sort_unstable`, `sort_by_key`, `binary_search`, and a composite-key sort over `Option(f64)`, `Reverse(f64)` and a derived `Ord`), `tests/collections/btree-map.test.yo` (the NaN key), `tests/collections/priority-queue.test.yo` (a max-heap and a `Reverse` min-heap of floats), `tests/iterator-combinators.test.yo` (`min`/`max`).
