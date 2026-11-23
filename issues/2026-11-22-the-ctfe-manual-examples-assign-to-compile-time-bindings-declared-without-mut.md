# The CTFE manual's examples assign to compile-time bindings declared without `mut`

**Severity:** S3 — four of the code examples in `docs/en-US/CTFE.md`, and the same four in `docs/zh-CN/CTFE.md`, are rejected by the compiler with E0917, starting with the first example on the page.

Filed 2026-11-22 while writing a compile-time search for
`plans/backlog/LOGIC_PROGRAMMING_ADOPTION_CANDIDATES.md` (LP5). `yo` 0.2.79
running the tree's `std` at `1e55e6c90`.

## Reproducer

The second example of the page, verbatim:

```yo ignore
sum_squares :: (fn(comptime(n) : i32) -> comptime(i32))({
  result :: i32(0);
  i :: i32(1);
  while(comptime(i <= n), {
    result = (result + (i * i));
    i = (i + i32(1));
  });
  return(result);
});

total :: sum_squares(5);
```

```text
error[E0917]: Cannot assign to `result`: it is a compile-time binding declared without `mut`, so it is immutable (plans/VALUES_BY_DEFAULT.md decision 47).
help: declare it `mut(result) :: ...` (or `comptime(mut(result)) := ...`)
```

Each Yo block of the page was extracted and run through
`yo check <block> --std-path ./std`. Blocks 1, 2, 3 and 9 report E0917 in both
languages: `factorial`, `sum_squares`, `sum_odd` and `is_prime`.

## Cause

Decision 47 made a compile-time binding immutable unless it is declared
`mut(x) :: v`. The page's prose was updated (its "How It Works" section
states the rule) and these four examples were not. The docs check does not
catch them: `scripts/check-docs.py` compiles only blocks that contain
`export(`, `test(` or `main ::`, and these are fragments.

## Fix

Declare the written bindings `mut(...)` in the four examples, in both
languages.

## Test

Give each of the four examples a `comptime_assert` and a `main` so the
`examples` check of `scripts/check-docs.py` compiles them.
