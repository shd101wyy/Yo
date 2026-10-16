# `return(a)` of a function-local `::` constant emits an undeclared C identifier

**Severity:** S2 — a valid runtime function that returns a local `::` constant with `return(...)` fails in the C compiler; binding it to a `:=` local first, or ending the body with `a`, works around it.

**Status:** fixed by #PRNUM (2026-10-16). Found 2026-10-15 while fixing `issues/fixed/2026-10-15-a-module-level-comptime-constant-can-be-assigned-at-runtime.md` (E0918). Not fixed there: this bug needs no assignment at all.

## Repro

Seed v0.2.62, `yo compile q.yo -o q && ./q; echo $?`:

```yo
{ exit } :: import("std/process");
f :: (fn(x : i32) -> i32)({ a :: i32(1); return(a); });
main :: (fn() -> unit)({ exit(usize(f(i32(5)))); });
export(main);
```

- **Expected:** the program exits with 1.
- **Actual:** `yo check` accepts it, and the C compiler rejects the emitted code:

  ```text
  q.out.c:1985:10: error: use of undeclared identifier '__yo_v_a'; did you mean '__yo_v_x'?
  ```

| Body                                   | Result        |
| -------------------------------------- | ------------- |
| `a :: i32(1); return(a);`              | C error       |
| `a :: 1; return(a);`                   | C error       |
| `a :: i32(1); a`                       | exits with 1  |
| `a :: i32(1); y := a; return(y);`      | exits with 1  |
| `return(A);` with a module-level `A :: i32(1)` | exits with 1  |

The `return(...)` argument path emits the local by name: `a` is compile-time only and has no C declaration. The tail-expression path and a `:=` read fold `a` to its value.

`unwind(a)` of a handler-local `a :: …` failed the same way (`{ int32_t _unw_val = __yo_v_a; … }`). A `return(a)` nested in a block or a `cond` arm worked: only a `return`/`unwind` that is a statement of the block declaring `a` failed.

## Resolution

The cause was in the evaluator, not in codegen's `return`. `generate_atom` (`src/codegen/exprs/atom.yo`) already folds a compile-time-only local, but it decides that by looking `a` up in the atom's recorded env, and that env no longer contained the block's frame.

The `return(val)` and `unwind(val)` branches of `evaluate_begin_expression` (`src/evaluator/exprs/begin.yo`) continued the block from the argument's env through `expr_info_adopt_env`. That function repoints the argument's `ExprInfo.env` at the env object it returns, so the block's live env and the argument's recorded env were one object. At the block's end, `pop_frame_nonmutating` reassigns that object's `frames`, which removed the block's frame from the argument's recorded scope as well. Codegen then found no variable `a`, fell back to the variable's C name, and emitted `__yo_v_a`.

Both branches now take a private copy (`snapshot_env(&info.env)`) that the argument's `ExprInfo` does not share, as their comments already intended ("by private copy").

Regression test: `tests/comptime.test.yo`, "return of a function-local compile-time constant returns its value" (typed and untyped constants, a constant returned after a runtime statement and an early return, a `bool` constant, and `unwind(a)` from an effect handler). The batch fails to compile on a develop-built compiler without the fix (five `use of undeclared identifier '__yo_v_a'` errors) and passes with it.
