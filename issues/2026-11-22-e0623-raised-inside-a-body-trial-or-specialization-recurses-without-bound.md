# E0623 raised inside a body trial or a specialization recurses without bound

**Severity:** S2 — no miscompile; the process livelocks/recurses (SIGSEGV in `mi_malloc`) instead of reporting, but only while an E0623 fires inside the def-time trial / specialization machinery (a `comptime_expect_error` E0623 row in a test body, a generic call whose specialized body hits E0623, or `yo fix`'s pass loop on a file with reference-to-handle sites)

**Status:** OPEN (found 2026-11-22 by the VERDICTS-73 F2 lane, on v0280/deref-explicit @ 562aa9994 with the F2 tree binary)

## Reproducer (fastest)

```bash
cd <worktree>
mkdir -p /tmp/e623loop && cd /tmp/e623loop
cat > t.yo <<'EOF'
{ assert } :: import("std/assert");
P :: struct(n : i32);
test("an E0623 row in a test body", {
  b := Box.new(P(n : i32(1)));
  comptime_expect_error(b.n, "which has no member \"n\"");
  assert(b.*.n == i32(1), "explicit");
});
EOF
YO_STD=<worktree>/std <worktree>/yo-out/x86_64-unknown-linux-gnu/bin/yo test ./t.yo --parallel 1
# rc=139 (SIGSEGV in mi_malloc)
```

Also reproduces with `yo fix` on a file whose E0623 site sits in a plain
(concrete) function body:

```yo
{ println } :: import("std/fmt");
P :: struct(n : i32);
read :: (fn(b : &Box(P)) -> i32)(b.n);
main :: (fn() -> unit)({
  mut(b) := Box.new(P(n : i32(3)));
  println(read(&b).to_string());
});
export(main);
```

`yo check` of the same file (module-level / a plain `main` body) is CLEAN: the
E0623 is raised and reported once, rc=0. `check ./src` on the fully swept tree
is 273/273 green. The loop needs the error to be raised INSIDE the trial /
specialization / fix-driver evaluation path, or enough E0623 volume in test
closures (the deref-explicit batch).

## Diagnosis (gdb + YO_DEBUG_LAZY + a YO_DEBUG_FN_ORIGIN fid map)

The crash is an unbounded NATIVE recursion cycling through (fid map of the
v0280/deref-explicit build):

```
evaluate_function_call            (src/evaluator/calls/function.yo:10918)
_evaluate_function_call_unanchored (function.yo:11270)
evaluate_expression               (src/evaluator/exprs/expr.yo:128)
evaluate_begin_expression         (src/evaluator/exprs/begin.yo:1918, arms at 1930/1981)
_eval_and_check_specialized_body  (src/evaluator/calls/helper.yo:3465)
create_specialized_function_inline (helper.yo:3585)
create_specialization_at_call     (helper.yo:6286)
→ evaluate_function_call ... (repeats, one fs write per cycle in the fix run)
```

`YO_DEBUG_LAZY=1` shows a `[force-field] String.substring` / `[force-miss]
Allocator <: Comptime` pair repeating. An earlier variant of the crash (before
the E0623 construction stopped reading source) cycled through a `substring`
CTFE at the raise site; that part is fixed (see below), but the
specialization-cycle remains.

## What has been ruled out

- Not the error construction's std CTCE: `member_behind_deref_error` and
  `_not_callable_error` no longer call `substring`/`chars` at the raise site
  (commit 9626aa635), and the recorder no longer builds an error object at all
  in record mode (recorder commit a7bae282b) — the SWEEP now completes cleanly
  (7,650 edits, three passes, no crash).
- Not a shallow clone: `YoError`/`ArrayList`/`Diagnostic` clones are deep.
- Not stack exhaustion: `YO_MAIN_STACK_MB=8192` still SIGSEGVs.

## Suspect

`create_specialization_at_call` rethrows the trapped body error with
`_with_instantiation_note(err, ...)`, and the catching side (the enclosing
trial / the fix driver's catch-and-continue) re-enters a fresh specialization
instead of terminating — each level appends a note and nests a frame. E0623 is
the first error the tree raises in that position at volume.

## Fix sketch

Gate the two E0623 raise sites (the field hook in
`evaluate_property_access`'s `.Ok((stars, landed))` arm, and the
`g_member_behind_deref` rethrow at the E0610 site) the way decision 32's
deleted `_reject_wrapper_payload_clash` was gated
(`ctx.currently_specializing_function.is_some() ||
ctx.is_evaluating_generic_impl_specialization`), then make the specialized
body's recorded error surface at the call — the [kept] `dg` path exists for
exactly this. The `tests/deref-explicit.test.yo` row
`comptime_expect_error(_read_n(&b), "write \`x.*.*.n\`")` is the acceptance
test, with the two reproducers above.

## Tests

`tests/deref-explicit.test.yo` and `tests/deref-owner.test.yo` currently fail
their batches on this bug (26 and 16 tests not running); both pass once the
E0623 rows are removed, and `tests/deref-explicit-unsafe.test.yo` (pointer
rows) passes today.
