# An origin-qualified `&mut(T, p)` overflows the checker's stack

**Severity:** S2. `yo check` (and every command that evaluates the file) died with SIGSEGV, exit 139 and no diagnostic, on any type written `&mut(A, B)`. That is decision 43's spelling of an origin-qualified reference (`plans/backlog/REFERENCES_AND_ORIGINS.md` O1), so a user or agent writing from the plan hit it, as the N0 corpus did.

**Status:** FIXED 2026-10-21. Found by the N0 corpus (`tests/origins/corpus/get2-mut-pair.yo`) while recording what today's compiler does with each row.

## Symptom

On v0.2.67 (identical `src/` to develop at `3d3546a21`):

```yo ignore
_g :: (fn(xs : &mut i32) -> &mut(i32, i32))(xs);
main :: (fn() -> unit)(());
export(main);
```

`yo check` ran about 9 s, grew to about 1.1 GB resident (the 1 GiB main-thread stack) and died with exit 139. A parameter type (`xs : &mut(i32, i32)`), a local annotation and a type argument (`Option(&mut(i32, x))`) crashed the same way. The one-argument `&mut T` and the shared `&(A, B)` already gave diagnostics.

## Root cause

`&mut(A, B)` parses as the `&mut` marker call with two arguments. The evaluator's `&mut` arm (`src/evaluator/exprs/_expr.yo`) first asks `_borrow_operand_is_type(ast_expr_strip_borrow_marker(expr))`, to say "a borrow mode, not a type" when the operand is a type. The strip sees through a one-argument marker only, so for two arguments it returned the call itself, and the probe evaluated the same call again. The two functions recursed until the stack ran out. A backtrace under gdb shows two mangled frames alternating.

## Fix

The `&mut` arm rejects a marker with any argument count other than one before probing, naming the origin-qualified reference as not supported yet. Regression cases are `bs_origin_mut_result`, `bs_origin_mut_param` and `bs_origin_mut_type_argument` in `tests/borrow_spelling.test.yo`. Each one crashed the whole file before the fix.

When N1 lands `&mut(T, p)`, this arm is where the two-argument form becomes the reference type.
