# Passing a C `int` where `i32` is declared is accepted by the evaluator, and codegen splices a Yo type expression into a C identifier

**Status: OPEN.** Found 2026-08-25 while fixing
`issues/file-read-write-ignore-position-always-offset-zero.md`.

## Symptom

`std/libc/errno.yo:64` declares `EINVAL : int` (the C `int`).
`std/sys/errors.yo:80` declares `from_errno : (fn(errno : i32) -> Self)`.

Writing

```rust
exn.throw(dyn(IoError.from_errno(EINVAL)))        // int passed where i32 declared
```

is accepted by the evaluator. Codegen then emits a C identifier with a **Yo type
expression spliced into it**:

```c
} __yo_dyn_box_unknown_fn(T : Type) -> Type;

static __yo_dyn_box_unknown_fn(T : Type) -> Type* __yo_new___yo_dyn_box_unknown_fn(T : Type) -> Type(void* value);
```

clang then fails with a cascade that names nothing useful:

```
error: type specifier missing, defaults to 'int'; ISO C99 and later do not support implicit int
error: expected ')'
error: expected function body after function declarator
```

Wrapping the argument — `from_errno(i32(EINVAL))`, which is the idiom already
used at `std/sys/errors.yo:90` — makes it compile and pass.

## Why it matters

The diagnostic is useless: it points at generated C, names an identifier the
user never wrote, and says nothing about the actual mistake (an `int`/`i32`
mismatch at a specific call site). The `__yo_dyn_box_unknown_fn(T : Type)` name
says the dyn box was built over an UNRESOLVED function type, so the argument
mismatch left the receiver type unresolved and codegen printed the type
expression verbatim.

At least this one is LOUD. Its sibling —
`issues/struct-literal-missing-field-silently-accepted.md` — is the same family
(evaluator accepts a malformed construction) but fails silently with
uninitialised memory.

## Expected

An evaluator error naming the parameter, the declared type, the supplied type,
and the call site — the same as any other argument type mismatch.

## Related

- `issues/struct-literal-missing-field-silently-accepted.md`
- `issues/yo-self-async-await-argcount-overpermissive.md`
- the "~220 type-level swallow classes" recorded as still OPEN in
  `issues/fixed/self-hosted-compile-swallows-undefined-call.md`
