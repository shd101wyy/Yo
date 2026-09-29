# `check` of a test body with a recursive soft-generic local fn grows without bound

**Severity:** S2 — `yo check` of a `.test.yo` whose test defines a recursive local function with an `Impl(Fn)` parameter runs out of memory (48 GB footprint measured); `yo test` of the same file passes

**Status:** OPEN (reproduced and narrowed, not yet diagnosed).
**Found:** 2026-09-29, the `yo check --test-bodies` census (`plans/TYPE_SYSTEM_SOUNDNESS_HANDOVER.md`
§3.3): PLAIN `check` of `tests/closure_param_forwarding.test.yo` was killed at a 48 GB peak footprint
(7.1 GB RSS). The `imm_*.test.yo` files die with SIGBUS (rc 138) at about 6 GB RSS. They are not yet
narrowed and may be the same bug.

## Reproducer (measured with a 2.5 GB RSS cap)

```rust
{ ArrayList } :: import("std/collections/array_list");
test("t", {
  w2 :: (fn(depth : i32, get_info : Impl(Fn(k : i32) -> i32)) -> i32)(
    cond((depth <= i32(0)) => i32(0), true => (get_info(depth) + recur(depth - i32(1), get_info)))
  );
  x := w2(i32(2), (k : i32) => (k + i32(1)));
});
```

| Variant | `check` |
| --- | --- |
| as above (develop `b6b828772` binary, and the Phase 3 step 7 branch) | killed past the cap |
| the same body in `main :: (fn() -> unit)({ … })` | 88 MB, rc 0 |
| no `recur` (the soft-generic fn called once) | rc 0 |
| `recur` in a fn with no `Impl(Fn)` parameter | rc 0 |

`YO_DEBUG_SWALLOW=1` shows two trials only (the test body and the closure), so the growth is inside
one evaluation. The likely mechanism, not yet measured: the soft-generic function specializes on the
closure argument, `recur` re-enters the specialization, and the self-recursion guard
(`is_recursive_spec` in `try_to_call_function_with_arguments`, keyed on
`ctx.currently_specializing_function`) does not match in the test-body trial context.

## Next step

A probe build that counts the specializations minted for `w2`'s fid (`YO_SPEC_REPORT=1` if it covers
this path) and prints `currently_specializing_function` at each recursive call, in the test body and
in `main`.
