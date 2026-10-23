# Value struct and tuple drops are inlined one line per counted leaf at every drop site

**Severity:** S3 — a value type that nests a struct or tuple holding counted fields at several levels (a "diamond", `struct(a : T, b : T)` applied `n` times) gets drop code, compile time and compiler memory proportional to its 2^n counted leaves at every drop site; at `n = 20` a one-local program takes over three minutes and 2.2 GB to compile

**Status:** open. Found 2026-10-23 by the review of
`issues/fixed/yo-self-rc-depth-cap-skips-deep-teardown.md`. That fix exposed
it: before, every type nested more than 8 levels deep answered "nothing to
drop", so its drop code stopped growing at depth 8, and the value leaked. The
drop it emits now is correct; only its size is the problem.

## Reproducer

[`issues/repros/2026-10-23-value-struct-drops-are-inlined-per-counted-leaf.yo`](repros/2026-10-23-value-struct-drops-are-inlined-per-counted-leaf.yo)
binds `P(T) :: struct(a : T, b : T)` and one `Option(P^14(Tracked)).None`
local, where `Tracked` is a `ref` with `Drop`.

```sh
yo compile issues/repros/2026-10-23-value-struct-drops-are-inlined-per-counted-leaf.yo --emit-c --skip-c-compiler --std-path ./std
```

## Measurements

Measured by the review on the 64 GB Linux box (2026-10-23): develop
`ef153b749` ("before", which leaked these values) against the depth-cap fix
("after").

| program                                            | before            | after              |
| -------------------------------------------------- | ----------------- | ------------------ |
| `Option(P^n(Tracked)).None`, emitted C, n = 12     | 137 KB            | 948 KB             |
| the same, n = 14                                   | 138 KB            | 3.7 MB             |
| the same, n = 16                                   | 138 KB            | 16 MB              |
| the same, n = 16, full `-O2` build                 | 7.7 s, 364 MB     | 20.6 s, 720 MB     |
| `enum(Leaf(v : i32), N(k : P^n(Box(Self))))`, `compile --skip-c-compiler`, n = 18 | 9.1 s | 50.3 s (71 MB of C) |
| the same, n = 20                                   | 11.0 s            | 194.6 s, 2.19 GB   |

The same shapes with `i32` leaves are unchanged, and `yo check` of the n = 18
enum takes 7.8 s, so the time is spent in codegen.

## Root cause

`generate_drop_code_for_value` (`src/codegen/exprs/drop_dup.yo`) drops a
value struct or tuple INLINE, one statement per counted leaf, recursing
through every field path. A value enum instead calls a per-type function
(`_value_enum_rc_fn`, `__yo_venum_drop_*`;
`issues/fixed/value-enum-drops-are-emitted-inline-at-every-drop-site.md`).
A diamond has 2^n field paths, so the inline expansion is 2^n statements at
every site, and the walk asks `type_contains_rc_cell_or_move_only` again at
every path.

The value itself holds 2^n words, so the RUNTIME work of dropping it is
inherently 2^n. Only the code size and the compile time can shrink.

## Recommendation

Give value structs and tuples the per-type drop and dup functions value enums
already have: one `static inline` function per type that drops its fields by
calling the fields' own functions. Code size then grows with the number of
distinct types (n), not the number of paths (2^n). This changes the emitted C
at every value-struct drop site in the compiler, so it needs its own emit-size
and runtime measurement (as the value-enum change had), not a side fix.
