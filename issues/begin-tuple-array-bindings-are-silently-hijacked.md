# `begin`, `tuple` and `array` bindings are silently hijacked — missing from the reserved-builtin list

**Severity:** S3 — `yo check` accepts a binding of these names and the program
then misbehaves silently (`begin`/`tuple`: the definition never runs and calls
evaluate to unit) or fails later with a hard-to-read error (`array`: the
evaluator reads the call as an array literal). Found 2026-09-30 while closing
out the LSP audit (`plans/LSP_AUDIT_2026-09-29.md`): `textDocument/rename`
validates `newName` against `is_reserved_builtin_binding_name`
(`src/lsp/rename.yo`), so the hole also let rename splice `begin` into a buffer
whose binding would never run.

## Reproduction

With any yo ≥ the reservation policy's landing (probed on installed v0.2.46):

```rust
// silent: prints "()" — begin() never runs the user's definition
{ println } :: import("std/fmt");
begin :: (fn() -> i32)(i32(1));
main :: (fn() -> unit)({ println(begin().to_string()); () });
export(main);
```

`yo check` passes; `yo compile --optimize 2` succeeds; the program prints
`()` instead of `1`. `tuple` behaves identically. `array` is loud instead:

```rust
array :: (fn() -> i32)(i32(1));
main :: (fn() -> unit)({ println(array().to_string()); () });
```

fails with `error: Expected at least one element in array, got 0` at the call —
the evaluator parsed `array()` as the array-literal builtin, not the user's fn.
A file binding all three (plus combining their calls in one expression) even
reached `yo compile` through `check` and died with an internal
transpile-ICE for main's body.

## Root cause

`is_reserved_builtin_binding_name` (`src/token.yo`) reserves "every BF_/BK_
builtin spelled as a plain identifier" — but `begin`, `tuple` and `array` are
special call-HEADS in the evaluator's dispatch (see the head list in
`src/evaluator/effects/mutation_summary.yo`: begin/cond/while/if/…/tuple/array
stand beside the already-reserved clone/consume/the/as/dyn/runtime/quote/recur/
unwind), and the three lex as plain identifiers, so a user binding of the name
is silently resolved to the builtin instead. `thread_local` looks similar but
is only special in the `(thread_local(name) : T) = init;` LHS position — a
general binding works and runs correctly (probed: prints 1), so it stays
unreserved. `Tuple`/`Array` (capitalized) are loud: binding them fails at eval
with E0603, not silently, and loud failures are outside this policy.

## Fix

Add `begin`, `tuple`, `array` to `is_reserved_builtin_binding_name`. The gate
already runs at every binding site (`src/evaluator/exprs/binding.yo`,
`initialization_assignment.yo`, `destructuring_assignment.yo`, prelude-exempt)
and in the LSP rename validation, so one list edit covers the compiler and the
rename box. Nothing in `src/` or `std/` binds these names (grepped), so no
other tree needs the prelude exemption.
