# An `Rc` field operand is read after a later argument releases the handle (use after free)

**Severity:** S1 — miscompile of evaluation order: `(h.tag + eat(h))` with `h : Rc(Holder)` reads `h->tag` after `eat(h)` released the last reference (ASan heap-use-after-free); the program is accepted.

**Status:** open (codegen). Found 2026-10-25 while fixing
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

## Proposed fix

In the argument loop, when a later argument may have side effects (`_expr_may_have_side_effects`,
`src/codegen/exprs/and_or.yo`), spill each earlier by-value argument whose code is not a literal, a
comptime value or a fresh temp into a temp before generating the later one. `&`/`abi_is_ptr`
arguments are left alone (decision 28's E0910 lend rules cover them). The emit-diff over the compiler
will be large. `issues/2026-10-25-a-by-value-operand-is-read-after-a-later-mut-argument-writes-it.md`
has the same root cause and the same fix.
