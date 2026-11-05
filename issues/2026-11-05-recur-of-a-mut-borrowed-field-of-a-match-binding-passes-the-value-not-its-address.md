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

## Root cause (located in the C, not yet in the codegen)

The emitted recursion:

```c
__yo_t_3042844248967136054* __yo_v_n = &((*__yo_v_slot));
yo_id_5996446586942427380000000((*(*__yo_v_n)).__yo_v_next, __yo_v_v);
```

The argument is the field's value; the named call emits `&((*(*__yo_v_n)).__yo_v_next)`. So
`recur`'s argument lowering skips the address-of for a `&mut` place reached through a `match`
binding over a borrowed scrutinee (a binding that is itself a pointer, `__yo_v_n`). This is the
`&T`-parameter-by-pointer ABI's recur path (#1771/#1773 changed the neighbouring binding and
arrow-method paths).

## Test

The fix adds the reproducer as a test case (a recursive `&mut` walk to the last node through
`recur`) and moves this doc to `issues/fixed/`.
