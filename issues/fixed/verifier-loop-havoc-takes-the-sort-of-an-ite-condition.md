# Verifier: a loop havoc sized a `cond`-bound integer as Bool and a comparison-bound bool as a bit-vector

**Severity:** S2 — `yo verify` rejected valid loops: a name assigned in a loop body whose pre-loop value was a `cond(...)`, a comparison, a popped list or a branch-local push got the wrong sort, and true contracts (even `r || !(r)`) came back REFUTED, or, since #1050, as a solver error.

- **Status:** FIXED on `feat/verifier-dml-fixtures` (2026-09-30), found while
  verifying `filter` over an `ArrayList` (R1 of
  `plans/backlog/ATS_STYLE_INDEXED_TYPES.md`).
- **Component:** `src/verifier/vc.yo` — `_term_width`, `_havoc_binding_sort`.

## Reproducer (measured: compiler built at develop `5101639ad`)

`tests/spec/fixtures/valid/loop_havoc_sorts.yo`:

```rust
count_up :: (fn(b : bool, n : i32, requires((n >= i32(0)) && (n < i32(100))), ensures(r >= i32(1))) -> (r : i32))({
  (x : i32) = cond(b => i32(1), true => i32(2));
  (i : i32) = i32(0);
  while(i < n, {
    invariant((i >= i32(0)) && (i <= n), (x >= i32(1)) && (x <= (i32(2) + i)));
    x = (x + i32(1));
    i = (i + i32(1));
  });
  x
});
```

```
loop-invariant-iterate: REFUTED  counter-example: __yo_hv1_i = #xffffffff, __yo_hv1_x = false, n = #x00000000
```

The second function binds `(f : bool) = (a < c)` and reported
`ensures(r || !(r))` REFUTED with `__yo_hv2_f = #x00000000`.

`filter` over a list (`tests/spec/fixtures/valid/dml_list_zip_filter_reverse.yo`)
hit the list form: its `out.push` sits inside an `if`, so `out` after the
branch is `ite(c, pushed, out)`, and the havoc declared it `Bool`
(`__yo_hv2_out = false`).

## Root cause

`_havoc_assigned` takes the havoc constant's sort from the name's pre-loop
term (`_havoc_binding_sort`). For anything but a `Var`, that read
`_term_width`, which sized every `App` by its FIRST argument: an `ite` by
its Bool condition, a comparison by its operands, an extend or extract by
its input. A list-building `Ctor` (after `pop`) was width 1, so Bool too.

## Fix

- `_term_width` of an application is now per operator (`_app_width`):
  - comparisons and connectives are Bool;
  - `ite` has its branch's width;
  - `sign_extend` / `zero_extend` add their extra bits, `extract` is
    `hi - lo + 1`, `int2bv` is its width;
  - `select` has the array's element width (`_array_elem_width`, which also
    reads a list's contents projection).
- `_havoc_binding_sort` gives a list constructor its list datatype sort and
  an `ite` the sort of its branch.
