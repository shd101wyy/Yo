# Compiling 64-bit-boundary comptime arithmetic aborts the compiler under safe-mode traps

Discovered by the full-corpus hollow sweep on develop after safe mode 3
(#837): `tests/comptime_overflow.test.yo` went RED — not because the file's
assertions are wrong, but because the COMPILER ITSELF aborted (rc=134) while
comptime-evaluating it.

## Verbatim behavior

Under a Phase-3 self-hosted compiler, compiling the file aborts with the
integer-overflow trap diagnostic pointing into
`src/evaluator/builtins/comptime_numeric_fns.yo`, and the sweep scores the
file RED:

    FAIL: failing file(s) not in scripts/bootstrap/known-failing.tsv — a NEW
    regression under the self-hosted compiler.
      tests/comptime_overflow.test.yo	RED

## Minimal reproducer

    // tmp/fixme.yo — the boundary value is the i64.MIN BIT PATTERN
    big_sum :: (u64(9223372036854775807) + u64(1000));
    main :: (fn(io : Io) -> unit)({});
    export(main);

    yo compile tmp/fixme.yo --skip-c-compiler

## Root cause

Comptime integers are carried as i64 (the bootstrap), and u64 values above
`i64::MAX` are stored as NEGATIVE bit patterns — producing those patterns
REQUIRES arithmetic that wraps in the i64 domain. Safe mode 3 turned every
raw `+`/`-`/`*` in the compiler's own source into a trapping builtin, so the
wrap-by-design carrying arithmetic became compiler aborts:

- `check_int_overflow`'s caller computed the raw result `a + b` / `a * b`
  BEFORE the overflow check could classify it, so `u64(i64::MAX) + u64(1000)`
  trapped on the raw add.
- `_i64_op_wrapped`'s mul probe `(a * b) / a != b` formed the overflowing
  product it was trying to detect, and could divide `i64.MIN` by `-1`.
- `bit_not_int`'s identity `~n = 0 - n - 1` traps on `n = i64.MIN` (the
  `u64(2^63)` pattern).
- the unary `neg` arm formed `0 - n` on the same pattern.

Pre-Phase-3 these were invisible: `-fwrapv` made the wrap silent, which was
exactly the semantics the carrying scheme depends on.

## Fix

The `wrapping_*` escape hatch (safe mode 3's keep-the-wrap surface) is a
pure-Yo generic whose every intermediate stays in range, so it is
comptime-evaluable — the evaluator instantiates it like any generic. All the
sites above now go through it:

- raw results: `a.wrapping_add(b)` / `wrapping_sub(b)` / `wrapping_mul(b)`;
- the mul probe: a division-free sign test on `a.wrapping_mul(b)` with
  explicit `MIN * -1` arms (the sign test alone misreads `MIN * 2` wrapping
  to 0);
- `bit_not_int`: `i64(0).wrapping_sub(n.wrapping_add(i64(1)))`;
- unary `neg`: `i64(0).wrapping_sub(n)`.

Regression arms added to `tests/comptime_overflow.test.yo`: `~u64(2^63)`,
`~u64(0)`, and two `comptime_expect_error` muls whose exact products leave
i64's range in both directions.

The same sweep surfaced two more deliberate-wrap sites the traps had turned
into aborts: the PCG-style LCG in `tests/bench_black_box.test.yo` (`_work`),
and a runtime arm inside `tests/comptime_overflow.test.yo` itself whose
comment still described the pre-Phase-3 "runtime `+` wraps" semantics — both
migrated to `wrapping_*`.
