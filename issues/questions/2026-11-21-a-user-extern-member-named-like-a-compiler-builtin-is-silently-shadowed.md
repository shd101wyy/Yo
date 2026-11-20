# A user `extern` member named like a compiler builtin is silently shadowed

**Kind:** design question — an open decision, not a defect.

**Status:** OPEN — found 2026-11-21 while fixing
`issues/fixed/2026-11-20-a-side-effecting-builtin-is-deleted-when-its-unit-value-is-bound-or-folded.md`.

## What happens

```yo ignore
extern("Yo", __yo_incr_rc : (fn(cell : *void) -> *void));
f :: (fn(c : *void) -> *void)({
  p := __yo_incr_rc(c);
  p
});
```

The evaluator dispatches `__yo_incr_rc` by NAME (`src/evaluator/exprs/dispatch.yo`)
before it looks at any binding, so the user's declaration is accepted and never
used: the call is typed `unit` (the builtin's type), not `*void`, and `f` is
E0604. No diagnostic says the declaration lost. The same holds for every
name-dispatched `__yo_*` builtin. A `__yo_*` name that is NOT a builtin binds to
a C runtime symbol whose signature the compiler owns and may change in any
release, with the user's declared signature unchecked against it.

The reserved-builtin-binding gate (`is_reserved_builtin_binding_name`,
`src/token.yo`) rejects user `::`/`:=` bindings of plain builtin names such as
`consume` or `va_start`, but extern members never reach it, and `__yo_*` names
are not in its list.

## Options

1. **Reserve the `__yo_` prefix for the compiler and std.** An `extern(...)`
   member (any ABI) whose name starts with `__yo_`, declared outside the std
   tree, is an error with a new E-code: "`__yo_` names belong to the compiler;
   call the builtin directly without declaring it, or use the std API".
   `pragma(Pragma.AllowUnsafe)` code keeps calling the builtins by name, as
   `tests/` does today.
2. **Reject only the dispatched builtin names.** Extend the reserved-name gate
   to extern members, with the builtin list as the source. This leaves the
   runtime-symbol case (an undeclared-by-std `__yo_*` C symbol) open.
3. **Let the declaration win.** Dispatch consults the binding first. This lets
   user code rebind RC primitives with arbitrary types, which is the bug class
   this question was found in.

## Recommendation

Option 1. The prefix is already the compiler's namespace in the C output,
the runtime and the builtin table; a prefix rule is one check at extern
evaluation with no list to keep in sync, and it covers both the shadowed
builtins and the unchecked runtime symbols. std's own `extern("Yo", __yo_…)`
blocks (`std/prelude.yo`, `std/allocator.yo`, `std/sys/externs.yo`,
`std/crypto/tls.yo`) are exempt by living in the std tree. A `yo fix` repair can
delete a user declaration that only re-declares a builtin.
