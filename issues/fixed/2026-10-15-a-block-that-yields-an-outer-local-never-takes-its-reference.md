# A block that yields an outer local never takes its reference

**Severity:** S1 — a block expression whose value is a local it does not own (an outer-frame local, a borrowed parameter) released that local's one reference a second time: heap-use-after-free, then a double free.

**Found:** 2026-10-15, develop battery run 38604999635 at `be5855a4a` (the same failure at `960a3904c`).
**Status:** FIXED 2026-10-15.

## Symptom

`tests/rc.test.yo` "a block that yields an outer local or is bound does not over-release" failed in 7 develop jobs (Linux x86 and arm, Windows, macOS Intel, wasm, the self-hosted test subcommand, the hollow sweep):

```text
==5696==ERROR: AddressSanitizer: heap-use-after-free on address 0x503000001874
READ of size 1 ... in __yo_decr_rc
```

Minimal repro (`--sanitize address --allocator system`, Apple clang):

```yo
ArgTemp :: ref(struct(n : i32));
at_read :: (fn(a : &ArgTemp) -> i32)(a.n);
main :: (fn() -> unit)({
  keep := ArgTemp(n : i32(23));
  _k := at_read({
    _z := i32(0);
    keep
  });
  x := {
    _z := i32(0);
    keep
  };
  _q := keep.n;
});
export(main);
```

The emitted C assigns the block's result temp from the local with no
`__yo_incr_rc`, then releases both:

```c
{ // begin block
  int32_t _z = 0;
  _file____User_temp_466749298118641770 = __yo_v_keep;
} // end begin block
__yo_t_...* __yo_v_x = _file____User_temp_466749298118641770;
...
__yo_decr_rc((void*)(__yo_v_x));
__yo_decr_rc((void*)(__yo_v_keep));
```

## Root cause

- The evaluator is correct. When a block's value is a local it does not own,
  `evaluate_begin` (`src/evaluator/exprs/begin.yo`, "Borrow/outer-frame share:
  balancing dup") marks the tail with a deferred `___dup`. The block's result
  temp then owns a reference of its own.
- Codegen consumes a deferred dup at the parent. A `match` arm's final
  expression goes through `arm_value_with_dups`
  (`src/codegen/exprs/match.yo`), and a `cond` arm does the same.
  `generate_begin` (`src/codegen/exprs/begin.yo`) generated its final
  expression with a bare `_call_generate_expr` and wrote `temp = value;`, so
  the dup was never emitted.
- The binding shape (`x := { …; keep }`) was already broken on seed v0.2.62:
  `x` adopted the un-dupped temp and released it. #1365 (`b88518aa0`) started
  releasing a block result that is not moved (a call argument, a discarded
  statement, a receiver), which fixed a leak. Its new over-release canary then
  exposed the missing dup in those shapes too. #1365 is correct, and so are
  the later merges (#1366, #1367).
- The canary passed locally because nix clang's ASan runtime does not work on
  this macOS ("AddressSanitizer is not functional … Skipping sanitizer").
  Without ASan the freed slot usually still reads back intact (3 of 5 runs
  passed).

## Fix

`generate_begin` emits its final expression through `arm_value_with_dups`,
as the `match` emitter does for a block arm. The result temp is then assigned
the dup's result. A single-expression block shares its id with its tail, so
the block's consumer emits those dups and `generate_begin` skips them.

`arm_value_with_dups` lives in `src/codegen/exprs/drop_dup.yo`, which imported
`_looks_like_minted_temp` from `begin.yo`. The helper moved to `drop_dup.yo`,
so the import graph stays acyclic.

## Verification

`tests/rc.test.yo` "a block that yields an outer local or is bound does not
over-release" now covers each shape against one outer local: a call argument,
a discarded statement, a receiver, a binding, a borrowed parameter yielded by
a block in a callee, and a last use that the dup/drop pair optimizer may turn
into a move. It checks the release count and `ref_count` after the inner
scope closes, so it does not depend on when the shared temp is released. Its
standalone extraction reports heap-use-after-free under ASan before the fix
and is clean after.
