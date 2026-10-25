# An `Rc` field operand is read after a later argument releases the handle (use after free)

**Severity:** S1 — miscompile of evaluation order: `(h.tag + eat(h))` with `h : Rc(Holder)` reads `h->tag` after `eat(h)` released the last reference (ASan heap-use-after-free); the program is accepted.

**Status:** fixed (codegen). Found 2026-10-25 while fixing
`issues/fixed/2026-10-24-a-dyn-closure-field-call-operand-runs-after-a-later-hoisted-argument.md`.
Same family, different operand: that fix turns a field CALL with a result temp into its own
statement, but a plain field READ is no call, so it is still emitted inline.

## Reproducer

`issues/repros/2026-10-25-an-rc-field-operand-is-read-after-a-later-argument-releases-the-handle.yo`,
built with `--std-path ./std --sanitize address --allocator system`:

```yo
{ assert } :: import("std/assert");
Holder :: struct(tag : i32);
eat :: (fn(sink(h) : Rc(Holder)) -> i32)(h.tag);
main :: (fn() -> unit)({
  h := rc(Holder(tag : i32(2)));
  assert((h.tag + eat(h)) == i32(4), "rc-field-add");
  ()
});
export(main);
```

```
==…==ERROR: AddressSanitizer: heap-use-after-free … READ of size 4
```

## Root cause (from the emitted C)

```c
int32_t tmp_eat = yo_id_…((__yo_t_…*)(__yo_v_h));   // eat(h): releases h's last reference
bool cmp = ((int32_t)__yo_add_chk_s((long long)(__yo_v_h->_u42_.__yo_v_tag), (long long)(tmp_eat), …)) == (4);
```

`generate_other_function_call`'s argument loop (`src/codegen/exprs/other_fn_call.yo`, `_materialize_arg`
per runtime argument) orders arguments only by the statements each one emits while it is generated.
An operand that stays an inline expression (`h->tag`) runs at its point of use, after every later
sibling's statement. The evaluator accepts the program: a scalar operator lends no operand, and in
source order the read happens before the move, as in Rust.

## Fix

`sequence_operand` (`src/codegen/exprs/other_fn_call.yo`): every operand loop — the plain-call
`_materialize_arg` path, the method-dispatch and dyn receivers/args, the runtime enum and object
constructors, the value-struct compound literal, the primitive-operator inline path
(`generation.yo`), tuples (`tuple_fn.yo`), arrays (`array_fns.yo`) and the fused-await argument
loop (`async.yo`) — passes each by-value operand's final code, after its deferred dup, to
`sequence_operand` with the operands in generation order. When a later operand can change what the
code reads (it names the operand's local root, or it is an expression that may write), the value is
copied into a fresh `__yo_seq_<n>` local declared at that point and the temp's name is used instead.
The copy is bitwise and owns nothing, so every dup/drop the evaluator scheduled is unchanged.
Address operands (`is_ptr`, `&x`, `&mut x`), settled codes (literals, comptime values, own temps),
the last operand and unit/never/unresolved-`SomeType` values are left alone. Regression tests:
`tests/rc.test.yo` "an Rc field operand is read before a later operand releases the handle" and
"a ref-handle field operand is read before a later operand writes it through an alias" (both failed
on the develop binary of 2026-10-25). The probe matrix in
`~/Workspace/Yo-wt/vbd-logs/operand-sequencing/matrix-fix.txt` is all OK under
`--sanitize address --allocator system`.

The same root and fix close
`issues/fixed/2026-10-25-a-by-value-operand-is-read-after-a-later-mut-argument-writes-it.md`.
Inside a state machine the spill is skipped when a later operand contains an `await` — that case
stays open as
`issues/2026-10-25-an-operand-before-an-await-in-a-later-operand-is-read-after-the-resume.md`.
