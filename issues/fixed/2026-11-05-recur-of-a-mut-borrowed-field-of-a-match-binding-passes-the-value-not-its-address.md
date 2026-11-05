# `recur(&mut n.next)` through a `match` binding passes the field's value, not its address: the C does not compile

**Severity:** S2 — a valid recursive walk over `&mut Option(Box(Node))` fails to build with a C type error; calling the function by name instead of `recur` works.

Found while migrating `tests/borrow_spelling.test.yo`'s linked list off `ref(struct)` (V5 part B,
branch `vbd/v5-part-b-tests`), on develop 68b45b81d.

## Symptom

```yo ignore
Node :: struct(value : i32, next : Option(Box(Self)));
last_value :: (fn(slot : &mut Option(Box(Node))) -> i32)(
  match(slot, .Some(n) => cond(n.next.is_some() => recur(&mut n.next), true => n.value), .None => i32(-1))
);
```

```
rm2.c:3063:91: error: incompatible pointer types passing '__yo_t_39875149648785780' (aka 'struct __yo_t_16403725905444119185_struct *') to parameter of type '__yo_t_39875149648785780 *' (aka 'struct __yo_t_16403725905444119185_struct **'); take the address with & [-Werror,-Wincompatible-pointer-types]
yo: error: compile: C compiler failed (exit 1) on rm2.c
```

Reproducer: `issues/repros/2026-11-05-recur-mut-field-of-match-binding-passes-value.yo`
(`yo compile <it> -o r && ./r`). Replacing `recur(&mut n.next)` with
`last_value(&mut n.next)` compiles and returns 2. The same `recur(&mut …)` on a plain
`&mut` parameter (`recur(&mut q.*, …)`) compiles too.

## Root cause

The emitted recursion:

```c
__yo_t_3042844248967136054* __yo_v_n = &((*__yo_v_slot));
yo_id_5996446586942427380000000((*(*__yo_v_n)).__yo_v_next, __yo_v_v);
```

The argument is the field's value; the named call emits `&((*(*__yo_v_n)).__yo_v_next)`.
`generate_recur` (`src/codegen/exprs/recur.yo`) lowered each argument with the plain
expression emitter and then only stripped a `(*name)` read back to `name` when `name` was a
pointer-bound variable. It never consulted the callee's C ABI, so a `&mut` place that is not
a bare pointer variable — here a field reached through the `match` binding's pointer and the
`Box` auto-deref — was passed by value to a `T*` parameter. A named call goes through
`_apply_ref_amp` (`src/codegen/exprs/other_fn_call.yo`) with the callee's
`fn_abi_param_is_ptr` flags, which folds `(*p)` to `p` and takes the address of an lvalue
chain.

## Fix

`generate_recur` lowers its arguments through the same `_apply_ref_amp`, with the current
function's `fn_abi_param_is_ptr` flags (`recur` calls the function it is in), in place of its
own `(*name)` strip. The same root decided VERDICTS-24's cursor walk over
`Option(Box(Node))` (decision 25), which lands in the same change.

## Test

`tests/local_borrows.test.yo`, "recur(&mut n.next) through a match binding reaches the last
node": the reproducer (`b_last_value` returns 2), plus a recursion that writes every node
through the address it was passed (`b_bump_all`). Both ran under `--sanitize address`.
