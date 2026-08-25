# Assigning to a by-value closure parameter under a generic result types the whole call `unit`

**Status: OPEN.** Found 2026-08-26 while adding `RwLock(T).with_read`
(STD_API_AUDIT §D7). Distinct from — but in the same family as —
`issues/generic-r-callback-with-unit-closure-emits-void-star-temp.md`: that one
is a codegen temp, this one is the evaluator picking the wrong `R`.

## Symptom

A callback-taking helper generic over the callback's result:

```rust
apply :: (fn(generic(R : Type), body : Impl(Fn(v : i32) -> R)) -> R)({
  x := i32(1);
  body(x)
});
```

called with a closure that assigns to its own BY-VALUE parameter before
producing a value:

```rust
b := apply((v) => {
  v = i32(9);
  (v + i32(0))
});
assert(b == i32(9), "...");
```

resolves `R` to `unit`, so `b` is unit and the next use of it fails:

```
check: error in: Error: Cannot unify incompatible types:
Expected: "bool"
Given: "unit"
```

The identical closure passed to a NON-generic helper
(`fn(body : Impl(Fn(v : i32) -> i32)) -> i32`) is accepted and behaves
correctly, so the assignment itself is legal — it is the generic-result
specialization that goes wrong.

Reproducer: `issues/repros/assign-to-by-value-closure-param-generic-result.yo`.

## Second shape: it can also reach codegen

With `std/sync/rwlock.yo`'s `with_read` (same signature) the error surfaces one
stage later instead — the specialization is registered with an UNRESOLVED `R`
and is then never emitted, so clang gets a call to an undeclared function:

```rust
lock := RwLock(i32).new(i32(3));
lock.with_read((v) => { v = i32(99); (v + i32(0)) });
```

```
error: call to undeclared function
  'yo_id_..._rtparam1_fn_v___i32_____R_ret_1821_cl1_closure_yo_id_...'
error: incompatible integer to pointer conversion initializing 'void *' with an expression of type 'int'
```

Note `_ret_1821` in the mangled name — the return slot is a raw SomeT id, i.e.
`R` never resolved.

## Why it matters

`RwLock(T).with_read` binds the protected value by value precisely so a reader
cannot write through to the shared cell. Yo has no read-only binding mode, so
that is a convention rather than an enforced rule — but a user who does assign
to the parameter today gets either a nonsense "Expected bool / Given unit"
message pointing at an unrelated line, or an undeclared-function error out of
clang. Neither says "you assigned to a by-value parameter".

The minimum acceptable behaviour is that `R` resolves from the closure body's
ACTUAL trailing type (`i32` here), matching the non-generic case.

## Not investigated

The evaluator side was not traced to a line. Suspects, from the notes already in
the tree: `src/evaluator/values/anonymous_function.yo`'s re-registration of the
closure's body type (it already documents a COMPTIME exclusion and a
`param_is_ref` loss in the same code path), and `check_and_add_argument`'s
Step-6 synthesis in `src/evaluator/calls/helper.yo`.
