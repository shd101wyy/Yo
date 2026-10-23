# Type-checking a deeply nested `Option` takes time exponential in the depth

**Severity:** S3 — `yo check` of a program nesting `Option` 18 levels deep takes about a minute and 24 levels runs past 5 minutes; a user generic enum or struct nested as deep checks in normal time

**Status:** open. Found 2026-10-23 while sweeping nesting depths for
`issues/fixed/yo-self-rc-depth-cap-skips-deep-teardown.md`. Not caused or
changed by that fix: the develop binary and the fixed one time the same.

## Reproducer

[`issues/repros/2026-10-23-nested-option-type-check-is-exponential.yo`](repros/2026-10-23-nested-option-type-check-is-exponential.yo)
binds `O1 :: Option(Tracked)`, `O2 :: Option(O1)`, … `O18` and constructs one
`O18` value.

```sh
yo check issues/repros/2026-10-23-nested-option-type-check-is-exponential.yo --std-path ./std
```

## Measurements

`yo check`, wall time, on the 64 GB Linux box (2026-10-23, loaded; checking
the std imports alone takes about 7 s). Peak RSS stays at about 140 MB, so the
time goes to repeated work, not to growing data.

| nesting                                           | d = 8 | 12    | 14     | 16     | 18     | 24       |
| ------------------------------------------------- | ----- | ----- | ------ | ------ | ------ | -------- |
| `Option(Option(…))` spelled inline, develop       | 7.5 s | 8.2 s | 11.7 s | 23.5 s | 65.0 s | —        |
| the same, with the depth-cap fix                  | 7.2 s | 8.3 s | 11.4 s | 19.4 s | 71.9 s | > 300 s (compile, timed out) |
| `O<k> :: Option(O<k-1>)` aliases, with the fix    |       |       | 10.8 s | 20.3 s | 56.0 s |          |
| user `W(T) :: enum(Some(f : T), None)`, d = 14/18 |       |       | 22.0 s |        | 19.2 s |          |
| user `W(T) :: struct(f : T)`, d = 14/18           |       |       | 30.0 s |        | 22.9 s |          |

(The user-generic rows ran while other heavy jobs loaded the box; they show no
growth with depth.) The extra time over the 7 s baseline about triples every
two levels, so some step does on the order of 2^d work per `Option`
instantiation. The alias row rules out the source text: inline spelling grows
quadratically with `d`, the aliases linearly, and both time the same.

## Where to look

Only the prelude's `Option` shows the growth, not a user enum of the same
shape. The difference is what the prelude attaches to `Option`: its trait
impls and derives, whose `where` bounds on `T` are judged per instantiation.
A check that resolves the bound on `T` once per impl or per variant, without
memoizing it, and recurses into `T` when `T` is itself an `Option` would
branch at every level. Not profiled yet: the release binary is stripped, so
a `perf` profile needs a symbolized build.
