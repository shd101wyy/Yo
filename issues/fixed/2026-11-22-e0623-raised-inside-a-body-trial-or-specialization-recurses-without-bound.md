# E0623 raised inside a body trial or a specialization recurses without bound

**Severity:** S2 — no miscompile; the process crashed (SIGSEGV in `mi_malloc`) or looped instead of reporting, whenever an E0623 was raised and the AST was walked again afterwards (a `comptime_expect_error` E0623 row in a compiled body, `yo fix` on a file with E0623 sites, a test batch's check)

**Status:** FIXED (2026-11-22, VERDICTS-73 F2 lane, `v0280/deref-explicit`). The title is the first diagnosis; the cause was a use-after-free, not a recursion.

## Reproducer

```yo
P :: struct(n : i32);
main :: (fn() -> unit)({
  b := Box.new(P(n : i32(1)));
  comptime_expect_error(b.n, "which has no member \"n\"");
  ();
});
export(main);
```

```text
$ yo compile m2.yo --skip-c-compiler        # F2 tree binary before the fix
rc=139
```

`yo check` of the same file passed (nothing walks the tree after the error);
`b.zz` (E0406 through the payload) compiled; `b.n` without
`comptime_expect_error` reported E0623 and stopped. The test-runner form
(`tests/deref-explicit.test.yo`, `tests/deref-owner.test.yo`: every batch
"failed to compile") and the `yo fix` form were the same crash.

## Root cause

gdb on the crash: a shallow stack, `collect_unwind_value_ctypes`'s walker
(`src/codegen/functions/gc-runtime.yo`) reading a node whose words were
garbage, four levels into `main`'s body — the receiver atom `b` of `b.n` had
been freed while still in the tree.

`member_behind_deref_error` (`src/evaluator/exprs/property-access.yo`) bound
`(mut(written), synth) := strip_synthesized_stars(obj)` and reassigned
`written` on the `for`-head path. The generated C for a `mut` name
destructured from a call's tuple, reassigned anywhere in the body, releases
both the binding and the tuple temporary's element at scope exit:

```c
__yo_v_written = _tmp._0; // Destructuring 0
...
__yo_decr_rc((void*)(__yo_v_written));
__yo_decr_rc((void*)((_tmp)._0));
```

`strip_synthesized_stars` returns `Rc.clone(obj)`, so every E0623 dropped the
receiver node's count by one more than it raised it. That codegen defect is
pre-existing and is filed separately:
`issues/fixed/2026-11-22-a-mut-name-destructured-from-a-call-result-is-released-twice.md`
(S1, open).

The earlier suspects (the repair's `substring` CTFE at the raise site, a
specialization rethrow loop) were the same freed node seen through different
later walks.

## Fix

`member_behind_deref_error` binds every name once
(`(stripped, synth) := …`, then `written`/`for_mark_s`/`total`/`shown_ty`
from a `for_marker` option); it was the only `(mut(x), …) := call()` in
`src/` and `std/`.

## Tests

- `tests/deref-explicit.test.yo` and `tests/deref-owner.test.yo` (their E0623
  rows, including `comptime_expect_error(_read_n(&b), "write \`x.*.*.n\`")`
  through a generic body) compile and pass; before the fix every batch failed
  to compile.
- `tests/cli-cases/fix-inserts-a-deref` (`yo fix` over one-, two- and
  reference-to-handle chains, second run a no-op).
