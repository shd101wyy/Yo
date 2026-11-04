# A move in the right operand of `&&` / `||` leaks the value when the operand is skipped

**Severity:** S2: a move-only local that only the right operand of a
short-circuit operator consumes is never dropped on the path that skips that
operand. Its `Drop` never runs and its buffer leaks once per evaluation; the
compiler's own verifier leaks this way on every list-mutating function it
checks.

> Found 2026-11-04 while running `tests/internal/verifier_list_len.test.yo`
> locally (LeakSanitizer reports 9 bytes per test). CI does not see it: the
> FV job and the internal shards run with `YO_TEST_LEAK_VERDICT=0`. The
> leak reproduces with tree binaries from the B8, B9 and B10 branches and
> from develop f82291470, so it is older than the B10/B11 flips.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");

eat :: (fn(o : Option(String)) -> bool)(
  match(
    o,
    .Some(s) => (s == String.from("x")),
    .None => false
  )
);

f :: (fn(a : bool) -> bool)({
  bdt := Option(String).Some(String.from("ArrayList"));
  a && eat(bdt)
});

main :: (fn() -> unit)({
  println(f(false));
  println(f(true));
});
export(main);
```

`yo compile --sanitize address --allocator system` and running it reports
`SUMMARY: AddressSanitizer: 9 byte(s) leaked in 1 allocation(s)`: the
`"ArrayList"` buffer of the `f(false)` call, where `eat(bdt)` never runs.

## Where it bites the compiler

`src/verifier/vc.yo` (`verify_function_body`, the list-alias pair check):

```yo ignore
bdt := match(input.param_types.get(apj), .Some(bpt) => _list_dt_of_type(&bpt), .None => Option(String).None);
if((apj != api) && (bdt.is_some() && (bdt.unwrap() == adt.clone().unwrap())) && ..., { ... });
```

`bdt.unwrap()` is the only consumer of `bdt`, and it runs only when
`apj != api`. The emitted C drops `bdt` on no path (it is treated as moved
unconditionally), so every iteration with `apj == api` leaks the cloned
data-type name. Any list-mutating function the verifier checks goes through
this loop.

## Fix shape

Treat a move inside the right operand of `&&` / `||` as a conditional move,
the way a move in one branch of a `cond` is: drop the value on the path that
skips the operand (or keep a drop flag). The regression test is the
reproducer above under the leak verdict, plus a `Drop` type whose drop
count is asserted for both values of `a`.
