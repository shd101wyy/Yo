# A borrow-flag builtin on a value-rooted place emits invalid C

**Severity:** S3 — `__borrow_guard(&v)` (or `__yo_borrow_acquire`/`_release`/`_assert_unborrowed`) on a value struct failed to compile in C; no shipped std path reaches it yet, but V2b's value collections would.

Found 2026-10-14 while writing the design note for the values-by-default
plan's unique buffers (`plans/VALUES_BY_DEFAULT.md`, V2b, "Unique buffers").

## Symptom

The three borrow-flag builtins cast their operand to `void*` and hand it to
the C runtime, which reads the flag out of the operand's cell header. On a
value-typed operand that is a struct, and the cast does not compile:

```yo
Buf :: struct(_n : usize);
derive(Buf, Copy, Clone);
main :: (fn() -> unit)({
  s := Buf(_n : usize(3));
  g := __borrow_guard(&s);
});
export(main);
```

`yo compile --emit-c` (v0.2.62 seed) emits

```c
__yo_borrow_acquire((void*)(__yo_v_c));
```

with `__yo_v_c` a `struct`, which no C compiler accepts.

## Root cause

`generate_yo_inline_function_call` (`src/codegen/exprs/inline_fns.yo`) emitted
the runtime call for every operand type. Only a reference type
(`ref(struct)`, `ref(enum)`) has a header to hold the flag. Until V2b no
caller passed anything else: the borrowed `for` guards collections, and every
collection is a `ref(struct(...))` today.

## Fix

The builtins lower to nothing when their operand is not a reference type
(`_borrow_operand_has_flag`). That is the plan's §3.10 rule, "the
borrowed-`for` guard splits by path": a value-rooted place is checked
statically under unique ownership and needs no run-time flag, and a place
reached through an `Rc` deref keeps the guard on that cell.

The predicate reads the operand through a call-site `&x` marker
(`ast_call_args_unmarked`). The evaluator annotates the place under the
marker, not the marker node, so the guard's `Dispose`
(`__yo_borrow_release(&self._c)`) found no type on the raw operand and kept
the cast. The first version of the fix missed that, and only the release
still failed.

## Verification

`tests/for_macro_borrow.test.yo`, "a borrow guard over a value-rooted place
sets no flag", compiles and runs with the tree-built compiler. Before the fix
the same test failed at the C compile, at the acquire and then, with the
first version of the fix, at the release.
