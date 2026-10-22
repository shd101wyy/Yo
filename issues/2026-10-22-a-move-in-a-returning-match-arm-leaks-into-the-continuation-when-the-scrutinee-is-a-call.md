# A move in a returning `match` arm leaks into the continuation when the scrutinee is a call

**Severity:** S2 — a valid program is rejected with E0901. A `match` arm that
moves a value and then `return`s never reaches the code after the `match`, yet
when the scrutinee is a call result, the move is merged into the continuation
and a later use of the value is reported as a use after move.

**Status:** open. **Found:** 2026-10-22 by the V2b B8 flip probe
(`plans/handover/VBD_B8_PROBE_CENSUS_2026-10-22.md`). Once `TomlValue` holds
value lists, `std/encoding/toml.yo`'s `_classify_number` hits it: at line
1272, `digits := match(_clean_radix(...), .Some(s) => s, .None => { return(bad); })`
is followed by `.None => bad` at line 1279. The v0.2.68 seed and develop
`e30c0d8ed` behave the same; the bug needs no flipped type.

## Reproducer

`issues/repros/2026-10-22-a-move-in-a-returning-match-arm-leaks-into-the-continuation-when-the-scrutinee-is-a-call.yo`:

```yo
{ println } :: import("std/fmt");
B :: struct(n : i32);
impl(B, Drop(drop : (fn(self : &mut Self) -> unit)(())));
id :: (fn(o : Option(i32)) -> Option(i32))(o);
f :: (fn(o : Option(i32)) -> B)({
  bad := B(n : i32(-1));
  v := match(
    id(o),
    .Some(x) => x,
    .None => {
      return(bad);
    }
  );
  cond((v > i32(0)) => B(n : v), true => bad)
});
main :: (fn() -> unit)({
  println(&f(.Some(i32(3))).n);
});
export(main);
```

```text
error[E0901]: use of moved value: `bad`
  --> ...:17:42      (the final `cond`'s `true => bad`)
note: value moved here
  --> ...:14:14      (`return(bad);` in the `.None` arm)
```

With the scrutinee written as the named parameter `o` instead of `id(o)`, the
program compiles and prints `3` under both binaries. A `return(cond(...))`
tail and a bare `cond` tail behave the same, and so do an `Option(String)`
payload moved out by `.Some(s) => s` and an `Option(i32)` one.

## Root cause (hypothesis)

The flow join after a `match` should drop the moved-set of an arm that
diverges (`return`, `unwind`, a panic). It does so when the scrutinee is a
named local, but the call-result path seems to take a different route: the
temporary's scope or the owned-temporary binding judgement (the 2026-10-21
"match bindings of an owned temporary" liveness rule) merges the diverging
arm's moves anyway.

## Fix direction

Treat a diverging arm as unreachable at the join on every scrutinee path. The
regression test is the repro above, which should compile and print `3`.
