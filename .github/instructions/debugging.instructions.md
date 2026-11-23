---
description: "Use when debugging the Yo evaluator, C codegen output, or runtime issues. Covers gdb, debug print functions, and strategies for diagnosing compiler bugs."
---

# Debugging the Yo Compiler

## Probe before you fix

A mechanism that convincingly explains a symptom is wrong about half the time: five sound-looking explanations on this tree were each refuted by one gated print. A print costs one build; a wrong fix survives review and changes nothing.

1. **Probe before you fix.** Print at the predicate you believe decides, on BOTH a failing and a working case, and compare. A trace without a control is not evidence.
2. **When a probe is ambiguous, widen the probe; do not go back to reading.** When several sites could be the one, tag them all in one build (distinct `eprintln` markers) instead of bisecting by inference.
3. **Do not count one signal twice** (two views of the same layer are one confirmation), and **a green exit code can mean "nothing ran"**: `yo compile` exits 0 on a body emitted as an abort stub, and `yo check` never runs codegen.

## Evaluator debugging

- Print helpers: `type_to_string` (`src/types/string.yo`), `ast_expr_to_string` (`src/expr.yo`), `value_to_string` (`src/value.yo`); `are_types_compatible` (`src/types/compatibility.yo`).
- `ExprInfo.value == .None` is a runtime value; `EvalValue.UnknownVal(ty, is_runtime_only)` is a compile-time value whose type is known but whose value is not.
- Use `yo check <path>` for type-error loops (evaluator only, no C).
- Faster debug-trace builds of the compiler: `yo compile src/main.yo --emit-chunks auto --jobs 16 --optimize 1 -o /tmp/yo-dbg` (host: a stage 1). Gate on a real `yo build --std-path ./std`.

## Swallowed definition-time errors (`YO_DEBUG_SWALLOW=1`)

Function and closure bodies are trial-evaluated at DEFINITION time; a failing trial is swallowed, so the body emits no diagnostic and codegen emits a `// Failed to transpile` abort stub. That is the most common cause of a hollow function. `YO_DEBUG_SWALLOW=1` shows which body failed and why:

| line | emitted by | covers |
| --- | --- | --- |
| `[trial] <pos>` / `[swallow] <err>` | `evaluator/calls/function-type.yo` | named `fn`/`ctl` bodies |
| `[anon-trial] <pos>` / `[anon-swallow] <err>` | `evaluator/values/anonymous-function.yo` | `=>` and `->` bodies, including every `io.async` closure |
| `[mat-default-swallow] <err>` | `evaluator/values/impl.yo` | per-impl materialization of a trait `?=` default |
| `[reeval-swallow] <err>` | `evaluator/calls/helper.yo` | a closure body re-evaluated at a specialization |
| `[kept] site=<s> code=<c> owner=<pos>` | each of the above | why the swallow was NOT re-raised: `dg`/`dgc` (generic fn/closure trial; error recorded against the body, waits for a call), `anon-abstract`/`anon-ct` (type-variable or `comptime(x)` parameters), `fn-fwd` (waits for a forward comptime fn), `reeval-concrete`/`reeval-abstract`, `mat-default` |
| `[ftt-stub] kind=<k> fn=<c name> site=<pos> spec=<b> recorded=<b>` | `codegen/functions/generation.yo` | a body emitted as an abort stub: `superseded` (dead generic original) or `value`/`unit` (live); `spec` = a requested specialization, `recorded` = its generic trial kept an error |

- A `[…swallow]` line belongs to the nearest `[…trial]` line above it. Output is large: `YO_DEBUG_SWALLOW=1 yo compile tmp/fixme.yo --emit-c --skip-c-compiler --optimize 2 2>swallow.txt; grep -n swallow swallow.txt | tail`.
- A specialization that reaches emission hollow with `spec=true recorded=true` fails the compile with the recorded error, noted at the requesting call. `scripts/soundness/swallow-census.sh` counts `[kept]` lines by site.
- `YO_DEBUG_LAZY=1` traces out-of-order evaluation: `[force] <def>` (`evaluator/context.yo`) per `::` definition or `impl` forced by a lookup miss; `[force-field] <type>.<member>` (`evaluator/values/impl.yo`) per sibling method forced inside its own impl (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`).

### The reported error is not always the first

After a swallowed trial, a later pass over the now-hollow body can raise a DERIVED error through the real `exn`, pointed at correct code (`issues/fixed/contracted-ghost-fn-called-from-runtime-reports-a-unify-error.md`). Tells:

- A `[swallow]` whose message is a deliberate rejection, followed by an unrelated error: the rejection is the answer.
- A `[trial]` with no matching post-trial marker (`[flow-post]` for the `function-type.yo` site): something after the trial threw for real; look there.
- `check` reports the rejection and `compile` does not: suspect a sentinel key collision. A failed evaluation returns `make_err_expr()` and callers test "no ExprInfo"; ids start at 1 and `expr_info_table_set` refuses id 0 for that reason. A sentinel must never be a key real data can occupy. To find which handler ate an error, instrument every `throw : (...)` handler at once.

### Other `YO_DEBUG_*` channels

- `YO_DEBUG_CTFE` / `YO_DEBUG_CTFE2`: CTFE call failures. `YO_DEBUG_DISPATCH`: method dispatch. `YO_DEBUG_BIND=<name>`: type-variable binding.
- `YO_DEBUG_RRE=1`: return-type re-evaluation, `[rre] callee=… hkt=… resolved_ret=…`. On E0613 for a call whose `T` should come from a closure, `hkt=T` means no forall binding reached the re-evaluation.
- `YO_DEBUG_FRESHEN`: per-call freshening of a generic callee's forall binders (`before-ids=` / `after-ids=`). Identical ids mean the freshening fired and changed nothing: `substitute` matches a `SomeT` on (name, frame_level) and the declaration's `forall_types` entry carries a different level.
- `YO_DEBUG_PARAMCHECK`: `[param-check] declared=… final=…`. Only a callee with no `FuncVal` (an `extern`, a builtin) goes through `try_to_call_function_with_arguments` → `check_if_function_parameter_matches_argument`; a Yo callee binds its own parameters in `evaluate_function_call`'s FuncVal arm (`[abstract-spec]`). "The same call with a Yo callee works" says nothing about the extern route. A `final` still naming the callee's binder means the re-evaluation lost a binding (`issues/fixed/a-generic-extern-called-from-a-generic-impl-member-fails-its-trial.md`).
- `YO_DEBUG_BORROW_MASK=1`: `[borrow-all]` lines, for a "Strict borrow: … may mutate" error on a method that only reads. An unresolvable call (an indirect call through a function-pointer field) counts as mutating everything.
- `YO_DEBUG_ASYNC_LAYOUT=1`: per `io.async` block, each closure parameter's declaration sites and each captured local's id, site and whether it got a state-machine field.
- `YO_DEBUG_BODY_SUMMARY=1`: `[body-summary] <module> offered=N summarized=M` (see below).
- `YO_DEBUG_CAPTURE=1`: the closure-capture pipeline (below).

## Evaluator facts that mislead

- **A struct's `id` does not contain its name**: `struct_decl_<module stem>_<anchor>_r<row>c<col>` (`stable_position_id`, `src/utils.yo`). Recognize a std type by `name` plus the module-stem prefix.
- **Which predicate makes a definition defer** (body checked per call): `should_defer_ft` (`src/evaluator/calls/function-type.yo`), reading `type_contains_some_type_for_codegen_param`, not `get_all_some_types`.
- **`check` gives each module its own ExprInfo table and drops it at module end** (`compile` and `test` share one). A walk over another module's body reads the memo `summarize_function_bodies` (`src/evaluator/effects/mutation-summary.yo`) took at that module's end. A `check`-only E0906 "never evaluated" on code `compile` accepts means a body was not summarized (`YO_DEBUG_BODY_SUMMARY=1`).
- **`Variable.is_module_level` means a RUNTIME global** (`g := …`); a `::` function has it `false`. A module's definitions are `finished_walk_for(module).defs`.
- **A func id does not name one body**: `stable_func_id(module, row, column)` survives a `--watch`/LSP re-evaluation that mints a new body. Key per-function memos by the body's `ExprId` too.
- **Environment frames**: `variable.frame_level` is the defining frame index; a function type's captured env is its definition-site env (minus the parameters frame); an impl's definition env is captured AFTER the generic frame is popped. `_reject_runtime_write_of_comptime_binding` (`src/evaluator/exprs/assignment.yo`) compares `frame_level` against the body's `eval_env` frame count to detect "declared outside this body", so a frame-count mismatch between the two envs gives false positives there.

## `YO_DEBUG_CAPTURE=1`: the closure-capture channels

stderr only:

- `[cap-fb]` (`exprs/identifer-and-operator.yo`): each FunctionBody-arm capture classification (name, frame found at, ctx frame count, stamped level, inner verdict, env top-frame ids).
- `[cap-track]` (`context.yo`): `track_variable_usage` gate decisions (re-found frame, own-param exclusion, compile-time-only flag).
- `[cap-enr]` (`utils/closure.yo`): enrichment input per name.
- `[cap-reg]` / `[fid-src]` (`function-value.yo`): capture-struct registrations and fid→source-key mints.
- `[fbctx-closure-call]` / `[fbctx-fnty-rp]` / `[fbctx-fnty-flow]` (`calls/closure-type.yo`, `calls/function-type.yo`): which site created a FunctionBody context.

A name `inner=false` in `[cap-fb]` that survives `[cap-track]`, appears in `[cap-enr]` and misses the `[cap-reg]` field list was dropped at capture-struct creation; a name missing from `[cap-track]` was never tracked (classifier); `cto=true` in `[cap-track]` against a runtime binding is a mis-classified UnknownVal argument.

## Codegen and generated C

- **Two C types for one Yo type** (clang: `initializing '__yo_t_A' with an expression of incompatible type '__yo_t_B'`, same layout): `type_key` (`src/types/type-key.yo`) is history-dependent (`g_tk_visited` renders a seen node id-only; `g_struct_cfid_keys` poisons a shared id to `!AMBIG`). Print the `type_key` of each collected type whose `type_to_string` matches (gated `eprintln` at the top of `collect_type`, `src/codegen/types/collection.yo`) and diff the keys token by token; the differing token names the nested type whose rendering split.
- **`YO_SCOPE_RELEASE`**: `compile` releases a body's recorded envs at scope exit and answers codegen name lookups from records (rules in `c-codegen.instructions.md`). `=off` keeps every env: right with `off`, wrong by default means a record is missing or wrong. `=shadow` checks each `scope_variables` answer against the records and prints `[scope-release] ... mismatch=N` and `[scope-release-kind] <count> <kind>` (`sv`, `rec`, or `fallback`). Branch `wip/scope-release-sitetag` (one commit; rebase it) tags each call site with `file:line`.
- **`yo compile -v` prints every C-compiler invocation** (`Compiling with: <cc> <argv…>`); `yo test -v` forwards it. Grep it to prove a flag (a sanitizer, an include path) reached cc.

### Naming `yo_id_…` frames: `YO_DEBUG_FN_ORIGIN=1`

Emitted C names are position hashes (`yo_id_<hash><occurrence>`). With `YO_DEBUG_FN_ORIGIN=1` every definition is preceded by `/* yo-origin <module>:<line> <c name> */`; `scripts/bootstrap/fid_name_map.py fresh.c fidmap.tsv` turns those into `fidmap.tsv` (`<c name>\t<file>:<line>\t<name>`) for `sample` profiles and rc-event reports.

### Leaks

- Reproducing an RC leak and writing a test that observes one: `testing.instructions.md` ("Writing a test that observes a LEAK"). LeakSanitizer does not work on macOS arm64; use `leaks --atExit -- ./repro_bin` ("0 leaks for 0 total leaked bytes" = clean).
- RC-dispose bugs: `__yo_decr_rc` frees fields only when `header->type_id != 0` (or `dispose_fn` under cycle GC); check that the constructor stamps a dispose id and `__yo_dispose_dispatch` has a case that drops the fields (`issues/fixed/ref-enum-missing-dispose-leak.md`).
- Leak roots: `scripts/bootstrap/alloc_site_census_t.py IN.c OUT.c dump.txt "<Type>" --rc-events` keeps each root's first and last 8 refcount events, plus `rc_event_report.py`.
- **An object referenced from everywhere** (an `ExprInfoTable`, an `Environment`): `--rc-balance` instead keeps each object's NET refcount change per call site, folding disposed objects into a "freed" histogram (the control) and survivors into "live". `rc_balance_report.py dump.txt <bin> fidmap.tsv` sums both per function: the missing release is in the function whose live net is positive while its freed net is about 0 (`issues/fixed/a-closure-typed-slot-never-releases-its-captures.md`).

## GDB and hangs

- `gdb ./a.out` on the generated C (C11, no GNU extensions). With `ptrace_scope=1`, `gdb -p` is refused: start under gdb (`gdb -batch -ex run -ex "thread apply all bt" --args …`; the nix shell has gdb), or sample a spinning thread with `perf record -e cpu-clock -g -t <tid>`.
- **A compiler that prints its result and then spins is a double free until shown otherwise.** mimalloc's release build leaves a cycle in a page free list and the thread-exit walk never ends. Recompile the emitted C against glibc malloc (`clang … -I scripts/bootstrap/libc_mimalloc`) and run under gdb: it dies at the bad `free`.
- **A CLI golden with `rc=124` is not evidence of a slow case.** If its kept stdout reaches the summary, the run finished and the process did not exit; a larger `timeout=` only waits longer.

## Workflow

- Limit output with `| head` / `| tail`; redirect long-running commands to a file (`&> out.txt`).
- **Never `git stash` in a worktree**: worktrees share the stash list with the main checkout, so `stash pop` can apply a peer's stash. Compare states with file copies (a copied `std/` must sit in a directory named `std`, or the prelude is not recognized).
- **Bisecting a regression**: confirm the test passes on `origin/develop` in a throwaway worktree (`git worktree add $HOME/Workspace/Yo-wt/bisect origin/develop`), then `git bisect` and read the first bad diff. Put debug info in error messages, not `println`: the test runner captures each test binary's stdout.
- **Editor errors on `.yo` files** come from the installed `yo lsp`, which can lag the tree; trust `yo check` with the tree binary. Rebuild the extension with `cd vscode-extension && npm run package`.

## Design docs for context

- Drop glue and the cell runtime: `c-codegen.instructions.md` ("Drop glue and the cell runtime")
- Async/await: `docs/en-US/ASYNC_AWAIT.md`; parallelism: `docs/en-US/PARALLELISM.md`; effects: `docs/en-US/ALGEBRAIC_EFFECTS.md`
- Low-level sys module: `docs/en-US/STD_SYS_MODULE.md`
- Reference cycles (they leak; `Weak` breaks them): `docs/en-US/MEMORY_SAFETY.md`, `docs/en-US/WEAK.md`
