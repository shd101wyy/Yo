# The RC-ownership builtins are callable outside `unsafe`

**Severity:** S1 — `b := __yo_rc_own(a)` in a safe file, with no `unsafe` and no `pragma(Pragma.AllowUnsafe)` anywhere in the program, is a heap use-after-free; `__yo_capture_field` and `__yo_dyn_dup` corrupt memory the same way.

Found 2026-11-21 by the VERDICTS-72 probes (`p12`, `p6`), on the v0.2.78 seed and on develop.
`issues/fixed/2026-10-22-the-rc-release-builtins-are-callable-outside-unsafe.md`
gated the six builtins that destroy a place in place and left the others
ungated as "non-destroying". Several of them add an owner the compiler does not
record, which is as unsound.

## Reproducer

```yo
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  a := Rc.new(i32(5));
  b := __yo_rc_own(a);
  n := ref_count(b);
  println(&n);
});
export(main);
```

`yo check` accepts it; `yo compile … --optimize 2 --sanitize address --allocator system` and running it reports `ERROR: AddressSanitizer: heap-use-after-free`.

Every `__yo_*` builtin the evaluator dispatches by spelling without a prelude
`extern` declaration (a prelude-declared one, such as `__yo_rc_forget_payload`
or `__yo_borrow_release`, is already rejected in safe code by rule D6), probed
in a safe file under ASan with the seed:

| Builtin | Safe-file probe | Result before the fix |
| --- | --- | --- |
| `__yo_rc_own(a)` | `b := __yo_rc_own(a)` on an `Rc(i32)` | heap use-after-free: `b` is a second owner holding no count |
| `__yo_capture_field(f, i)` | `t := __yo_capture_field(f, 0)` on a closure capturing a `String` | double free: `t` is a second owner of the captured field |
| `__yo_dyn_dup(d)` | on a `Box(Dyn(Show))` | bad free |
| `__yo_incr_rc(r)`, `__yo_incr_rc_atomic(r)` | on an `Rc`/`Arc` | leak (LeakSanitizer, 12 bytes) |
| `__yo_dup_array_element(a, i)`, `__yo_dup_tuple_element(t, i)` | the result discarded | leak; a bound result is a counted copy |
| `__yo_sometype_dup(x)` | on a `String` | no observable effect on that type (gated with its `dup` siblings) |

The others in that set are compile-time builtins (`__yo_comptime_list_*`, `__yo_type_*`, `__yo_expr_*`, `__yo_are_types_*`, `__yo_pointer_size_bits`, `__yo_comptime_string_to_expr`) or the build API (`__yo_build_*`), with no ownership effect.

## Root cause

`evaluate_yo_rc_own`, `evaluate_yo_incr_rc`, `evaluate_yo_incr_rc_atomic`, `evaluate_yo_dyn_vtable_dup`, `evaluate_yo_some_type_dup`, `evaluate_yo_dup_array_element`, `evaluate_yo_dup_tuple_element` (`src/evaluator/builtins/rc-fns.yo`) and `evaluate_yo_capture_field` (`src/evaluator/utils/closure.yo`) type their result without asking where the call is written.

## Fix

The eight evaluators reject a call written outside an unsafe-capable file through the destroying builtins' gate (`is_destroying_builtin_call_capable`: only the file the call is written in counts; `auto-generated://` code, where the compiler's dup expansion and closure-clone templates are parsed, is admitted, and the prelude declares the pragma). The diagnostic is `ownership_builtin_error_message` (`src/evaluator/memory-safety.yo`): `'<builtin>(...)' is not available in safe code`, naming `Rc.clone(h)` / `x.clone()`. Leaks are gated with the rest: these builtins are the compiler's lowering of copies, and safe code has the counted spellings.

`___dup` (not a `__yo_` name) stays as the 2026-10-22 doc left it: in safe code it leaks and does not corrupt memory.

## Test

`tests/safe-code-structural-gates.test.yo`, "the RC-ownership builtins are rejected in safe code": one `comptime_expect_error(..., "'<builtin>(...)' is not available in safe code")` row per builtin. Before the fix the seed accepts the first block, so the test fails.
