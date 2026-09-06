# `make_err_expr()`'s hard-coded ExprId 0 aliases the prelude in `compile`'s shared ExprInfoTable — a failed definition is masked, then blamed on a later, correct line

**Status:** OPEN
**Severity:** wrong-value. `yo check` and `yo compile` disagree about the SAME
file: `check` reports the real error at the real line, `compile` either blames a
correct line for a binding that exists, or silently succeeds and builds a binary
from a module the evaluator could not type-check.
**Found:** 2026-09-04, std-API audit re-measurement, while distilling async
reproducers — a three-line mistake cost ~20 minutes because the compiler pointed
at an `import` that was present and correct.

## Symptom 1 — a correct line is blamed for a binding that exists

```rust
{ println } :: import("std/fmt");
one :: (fn(v : i32) -> Impl(Nope))(v);
main :: (fn() -> unit)({
  println(String.from("ran"));
});
export(main);
```

```
$ yo check mini7.yo
error: Failed to evaluate Impl argument.
  --> mini7.yo:2:29
  |
2 | one :: (fn(v : i32) -> Impl(Nope))(v);
  |                             ^^^^
yo: error: check: 1 file(s) failed evaluator coverage

$ yo compile mini7.yo --optimize 2 -o mini7.out
error[E0401]: Variable "println" not found.
  --> mini7.yo:4:3
  |
4 |   println(String.from("ran"));
  |   ^^^^^^^
help: run `yo explain E0401` for more information
```

`println` is imported on line 1. The reader chases an import problem that is not
there. The real mistake — the undefined `Nope` on line 2 — is never mentioned.

## Symptom 2 — every binding declared BEFORE the failed definition disappears

```rust
A :: struct(a : i32);
one :: (fn(v : i32) -> Impl(Nope))(v);
B :: struct(b : i32);
use_b :: (fn(x : B) -> i32)(x.b);
use_a :: (fn(x : A) -> i32)(x.a);
main :: (fn() -> unit)(());
export(main);
```

```
$ yo compile mini6.yo --emit-c --skip-c-compiler
error[E0401]: Variable "A" not found.
  --> mini6.yo:5:18
  |
5 | use_a :: (fn(x : A) -> i32)(x.a);
  |                  ^
help: did you mean "B"?
help: run `yo explain E0401` for more information
```

`B` — declared AFTER the failed definition — resolves. `A` — declared BEFORE it —
does not, and the did-you-mean suggestion proves only the post-failure names are
still in scope. The module's environment was replaced part-way through the walk.

## Symptom 3 — `compile` silently accepts what `check` rejects

```rust
one :: (fn(v : i32) -> Impl(Nope))(v);
main :: (fn() -> unit)(());
export(main);
```

```
$ yo check mini8.yo
error: Failed to evaluate Impl argument.
  --> mini8.yo:1:29
yo: error: check: 1 file(s) failed evaluator coverage        # rc=1

$ yo compile mini8.yo --optimize 2 -o mini8.out ; echo $?
0
$ ./mini8.out ; echo $?
0
```

When nothing after the poisoned definition happens to reference an earlier
module-level name, the error vanishes entirely and `yo compile` builds and runs a
binary for a module `yo check` rejects. `--optimize 2` is not required; the same
holds with `--emit-c --skip-c-compiler`.

## Other observed triggers (same mechanism)

- `Impl(Future(i32, IoExn))` with `IoExn` not imported — the trigger that started
  this. Call this module `mini3.yo`; it is the one traced below:

  ```rust
  Opts :: struct(a : i32);
  one :: (fn(v : i32) -> Impl(Future(i32, IoExn)))(v);
  work :: (fn(o : Opts) -> i32)(o.a);
  main :: (fn() -> unit)(());
  export(main);
  ```

  `yo check` points at `IoExn` on line 2; `yo compile` says
  `Variable "Opts" not found. --> mini3.yo:3:17` for a struct declared on line 1
  and spelled correctly.
- `derive(Point, Eq)` (the bare-trait derive form): `check` reports a missing
  method, `compile` reports `Variable "Point" not found` at Point's later use.
  This is the already-filed
  `issues/fixed/bare-derive-form-kills-module-eval.md` (CLOSED 2026-09-05 — the
  derive-generated impl is no longer evaluated through a swallowing wrapper, so
  the arity error now lands on the `derive(...)` line). Its "Likely mechanics"
  section guessed at the cause; the chain below is the actual one. What is left
  of that doc is its own question — whether the bare derive form should be legal
  rather than rejected.

## Root cause

A four-link chain. Every link is in the tree today.

**1. The failure sentinel has a colliding id.** `make_err_expr()`
(`src/expr.yo:351-364`) returns `.Atom(usize(0), …)` — ExprId **0**, hard-coded.
Ids are minted from a single global counter that starts at zero
(`src/expr.yo:314`, `alloc_global_expr_id` at `:317`), so id 0 is a REAL id that
the first expression parsed in the process already owns. The hazard is even
documented three lines above, in `clone_expr_fresh_ids`' doc comment
(`src/expr.yo:326`): "(and id-0 synthesized nodes all collide)".

**2. The failure sentinel is how the evaluator signals "this did not evaluate".**
The three-argument `evaluate_expression` resolves to
`_evaluate_expression_wrapper` (`src/evaluator/exprs/_expr.yo:1117`), which
installs a capture-free handler that swallows every throw and
`unwind(make_err_expr())` (`:1136`). Callers detect the failure by looking the
returned node up in the ExprInfo table and finding nothing.

**3. Under `compile`, key 0 is occupied — by the prelude.** `compile` is the only
front door that shares ONE `ExprInfoTable` across the prelude and the entry
module: `src/main.yo:1783-1786` creates it, publishes it with
`mm_set_shared_expr_info_table`, and THEN preloads the prelude into it;
`mm_eval_entry_exprs` adopts the published table for the entry module
(`src/module_manager.yo:633-638`). The prelude is parsed first, so the prelude
owns expression id 0 and has an ExprInfo stamped at key 0 whose `env` is the
prelude env. `check` never sets that slot, so its per-file table has no key 0 and
the "no ExprInfo" signal works.

**4. The stale hit is read as success, and its environment is adopted twice.**
`evaluate_impl_constraint` (`src/evaluator/builtins/impl_constraint.yo:98-114`)
does exactly what step 2 expects:

```rust
eval_mod := evaluate_expression(module_expr, cur_env, ctx);
mod_info := match(
  expr_info_table_get(ctx.expr_info_table, ast_expr_id(eval_mod)),
  .Some(info) => info,
  .None => { exn.throw(… "Failed to evaluate Impl argument." …); … }
);
cur_env = mod_info.env;
```

Under `compile`, `ast_expr_id(eval_mod)` is 0 and the lookup returns the
PRELUDE's ExprInfo, so the `.None` arm never runs — the error is never raised —
and `cur_env` becomes the prelude environment. The `Impl(...)` node is then
stamped with it (`impl_constraint.yo:210-212`,
`new_expr_info(cur_env, …)`), and that env propagates out through the function
type to the top-level definition's ExprInfo.

Then the module walk adopts it wholesale. For every non-export top-level
expression, `evaluate_anonymous_module_begin_exprs`
(`src/evaluator/values/anonymous_module.yo:547-556`) does:

```rust
info_opt := expr_info_table_get(ctx.expr_info_table, ast_expr_id(evaluated));
match(info_opt, .Some(info) => {
  env.frames = info.env.frames;
  env.module_path = info.env.module_path;
  …
}, .None => ());
```

so the walk's env is REPLACED by the prelude env and every module-level binding
made before that point is gone. The remaining statements are evaluated against
the prelude, which is why `println` and `A` "do not exist" and `B` does.

`_evaluate_expression_wrapper` makes it worse on the way out: its inlined
`_bridge_expr_info` (`src/evaluator/exprs/_expr.yo:1140-1160`) sees
`oid != rid` (the real node vs id 0), finds no entry for `oid` and one for
`rid = 0`, and COPIES the prelude's ExprInfo onto the user's node.

The debug channel shows the whole thing in three lines
(`YO_DEBUG_SWALLOW=1 yo compile mini3.yo --emit-c --skip-c-compiler`):

```
[var-miss] name=IoExn env_module=file:///…/mini3.yo frames=4
[trial] mini3.yo:1:49
[var-miss] name=Opts env_module=/…/std/prelude.yo frames=2
error[E0401]: Variable "Opts" not found.
```

The second lookup runs against the prelude env with 2 frames instead of the
module env with 4. Under `yo check` the same trace stops after the first
`[var-miss]` and reports the real error.

**What is measured vs inferred.** Measured: `check` and `compile` disagree on the
same file; `compile` continues past the failed definition; the environment the
later lookups run against is the prelude's, with fewer frames; the shared
`ExprInfoTable` is the ONLY configuration difference between the two front doors
(`mm_load_file` never sets `g_shared_expr_info_table` — `src/module_manager.yo:280`
is written only from `src/main.yo:1784`); `make_err_expr()` returns id 0; the id
counter starts at 0; the prelude is parsed first under `compile`. Inferred, and
worth confirming with one `eprintln` at `impl_constraint.yo:100` when you start
the fix: that the `.Some(info)` the failure probe receives is literally the
prelude's expression-0 entry. Every alternative explanation has to account for the
prelude's `module_path` appearing on the adopted env, which nothing else in this
path can produce.

## Fix

Three changes, in increasing order of how much they cost.

1. **Stop using a real id as the failure sentinel.** Give `make_err_expr()` a
   reserved id that no parsed node can ever hold. Two options:
   (A) start `g_next_global_expr_id` at 1 and keep 0 as the reserved
   "error/synthesized" id — one line, and it also fixes every other id-0
   synthesized-node collision the `clone_expr_fresh_ids` comment warns about;
   (B) mint a fresh id per `make_err_expr()` call. **Recommend (A)**: it is
   cheaper, it makes the reservation explicit, and (B) grows the table with
   entries nobody reads. Whichever is chosen, add a comment at `src/expr.yo:314`
   saying id 0 is reserved.
2. **Make the module walk's env adoption defensive.** Even with (1), adopting
   `info.env` unconditionally at
   `src/evaluator/values/anonymous_module.yo:551-554` means any single mis-stamped
   ExprInfo silently truncates the module scope. Adopt only when
   `info.env.module_path == env.module_path`, and treat a mismatch as an internal
   error rather than silently replacing the frames. This is the same corruption
   shape as
   `issues/yo-self-dup-eval-inside-macro-generated-body-corrupts-module-eval.md`
   ("the next module statement's type lookup misses a binding that exists"), which
   may well close with it.
3. **Do not let `compile` be laxer than `check`.** After (1), `compile` will
   raise "Failed to evaluate Impl argument." like `check` does. Add a CI
   assertion that the two front doors agree — see the tests below — because a
   `compile` that accepts what `check` rejects (Symptom 3) is a silent-hollowing
   channel, the most expensive failure mode in this repo's history.

Do NOT fix this by special-casing `impl_constraint.yo` to re-check the id. The
"returned node has no ExprInfo means evaluation failed" convention is used
throughout the evaluator, and every one of those sites has the same exposure the
moment the sentinel's id collides.

## Regression test

- `tests/cli-cases/` is the right home for the front-door disagreement, because
  it is the only harness that runs the real CLI. Add
  `tests/cli-cases/compile-undefined-name-in-impl-arg/` (a sibling of the existing
  `compile-undefined-call` / `check-undefined-var-libc-import` cases) whose
  fixture is the three-line Symptom 3 module, with `expected_rc` = 1 and a
  `stdout_keep_match` on the real diagnostic. Verify red-first: today the case
  exits 0.
- Add the Symptom 1 module as a second case asserting that the reported line is
  the definition's, not the later `println`'s — `stdout_keep_match` on
  `Impl argument` is enough to pin it, since today the output says
  `Variable "println" not found`.
- `tests/internal/expr_info.test.yo` should assert the reservation directly: that
  `ast_expr_id(make_err_expr())` is never equal to the id of any parsed
  expression, i.e. that `alloc_global_expr_id()` never returns it.

Reproducers to promote into `issues/repros/`: the five-line Symptom 2 module
(which binding survives) and the three-line Symptom 3 module (silent success).
Both are self-contained and need no imports beyond `std/fmt`.
