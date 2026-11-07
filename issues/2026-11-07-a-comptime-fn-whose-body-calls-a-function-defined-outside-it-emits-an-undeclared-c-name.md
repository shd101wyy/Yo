# A `comptime_fn` whose body calls a function defined outside it emits an undeclared C name

**Severity:** S2 — a `::` binding of a `comptime_fn` call folds to nothing and no error is reported, so the program fails in the C compiler (`use of undeclared identifier`) instead of folding or being rejected.

Found 2026-11-07 on develop 142a2f972 while probing CTFE for the
borrowed-`for` fix lane (`fix/borrowed-for-over-mut-param-with-fn-slot`). The
v0.2.75 seed fails the same way, so it predates that lane and is unrelated to
its fix.

## Reproducer

```yo ignore
{ println } :: import("std/fmt");
helper :: (fn(y : i32) -> i32)(y + i32(1));
outer :: (fn(x : i32) -> i32)(helper(x));
c :: comptime_fn(outer);
r :: c(20);
main :: (fn() -> unit)({
  println(`r=${r}`);
});
export(main);
```

`yo compile` (tree binary at 142a2f972, and the v0.2.75 seed):

```
/tmp/forfix_c8.c:2350:40: error: use of undeclared identifier '__yo_v_r'
yo: error: compile: C compiler failed (exit 1) on /tmp/forfix_c8.c
```

`yo check` reports `evaluator OK`.

## Which shapes fail

Measured on the same binary, each a `comptime_fn(outer)` bound to `c`, then
`r :: c(20)` read at run time:

| `outer`'s body | result |
| --- | --- |
| `{ v := x; (v + i32(1)) }` (no call) | folds, prints `r=21` |
| calls a `helper` NESTED inside `outer` | folds, prints `r=21` (the case `tests/comptime_fn_nested.test.yo` covers) |
| calls a MODULE-LEVEL `helper` | the C error above |
| calls a `helper` declared beside `outer` in `main`'s body | the same C error |

The bindings may sit at module level or inside `main`; both fail.

## Where to look

The `comptime_fn` call yields no compile-time value, and the `::` binding it
feeds is left without one. Codegen then emits the binding's name as a C
identifier that nothing declares. That is the same last step as the nested-fn
gap fixed on 2026-08-05 (`issues/yo-self-ctfe-nested-fn-analysis-gap.md`).
There, the CTFE capability analysis never reached a nested named `fn`. Here
the callee is defined outside the converted function, so the comptime
execution of `outer` finds no compile-time version of `helper` to call. Two
outcomes would be correct: fold the call (`helper` is CTFE-capable), or
reject the `comptime_fn` conversion with a diagnostic, as the
`comptime_fn` comment in `tests/basic.test.yo` says ("Panic if fails to
convert"). Invalid C is wrong either way.

## Test

The test lands with the fix. A red test cannot sit in the suite while the bug
is open, because it fails its whole batch. `tests/comptime_fn_nested.test.yo`
should gain the module-level and sibling-local helper cases from the table
above, each asserting `r == 21`.
