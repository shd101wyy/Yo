# P1 — CLI parity for the self-hosted compiler

> **STATUS: COMPLETE** (2026-08-10). Every in-scope item is done and
> differential-verified; the two out-of-scope deferrals are recorded where
> they will be picked up — `doc --format html` → **done in P2** (§5),
> `version` → P3 (§6.5). Kept in `plans/` (not archived) because §5's
> markdown_yo notes and §9's debt list are the P2 pickup points.

**Handover doc. Start here.** Supersedes
[`archive/PRE_P1_HANDOVER.md`](PRE_P1_HANDOVER.md), whose question
("what must be true before P1 starts?") is answered: nothing is blocking, and
P1 has started.

P1 is defined in [`SELF_HOSTING_COMPLETION.md`](SELF_HOSTING_COMPLETION.md).
This document is the working state: what is done, what its own plan gets wrong,
what order to do the rest in, and the traps that have already cost time.

**Every number here was measured, not quoted.** Where this contradicts
`SELF_HOSTING_COMPLETION.md`, this document is the later measurement — several
of its figures are stale and are called out below.

---

## 0. Where P1 stands

|                      |                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hard blockers        | **none** — thirteen compiler/std/runtime bugs fixed (§2, §4, §5), each with regression coverage                                                                                                                                                   |
| Subcommands wired    | `check`, `compile`, `test`, `fmt`, `init`, **`cache`**, **`build`**, **`fetch`**, **`install`**, **`doc`** (json + markdown)                                                                                                                      |
| Subcommands left     | `doc --format html` **DONE 2026-08-10** (ported after this doc was written — `yo-self/doc/render_html.yo` + the vendored `markdown_yo` submodule; pinned by the `doc-html` cli-case, byte-identical to TS). `version` still deferred to P3 (§6.5) |
| `fmt` divergence     | **0** of 808 files (was 339, then 17)                                                                                                                                                                                                             |
| Differential harness | `scripts/cli-diff-test.sh` + `tests/cli-cases/` — 10 cases, **all PASS**; it found 6 `build` bugs and 4 compiler/std bugs (§4, §5)                                                                                                                |
| Gates                | `gates_fast.sh` GATE 6 (`fmt` differential) and GATE 7 (CLI differential) are new                                                                                                                                                                 |
| Bootstrap            | FIXPOINT_HOLDS, stage-3 byte-identical                                                                                                                                                                                                            |

---

## 1. The harness exists now: `scripts/cli-diff-test.sh`

This was the top item and it is done. It runs a subcommand under both compilers
in two isolated sandboxes — **each with its own `HOME`**, so `~/.cache/yo`
mutations are part of the differential — and compares exit code, normalized
stdout, the project tree AND the `HOME` tree. `scripts/diff-test.sh` supplies
the verdict vocabulary and exit contract; the trees are what it adds.

Cases live in [`../tests/cli-cases/`](../tests/cli-cases/) — one directory per
case, with `cmd` / `fixture/` / `ignore` / `opts`. See its README.

```bash
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh          # whole corpus
YO_SELF_BIN=/tmp/yo-s1 scripts/cli-diff-test.sh init -v  # one case, verbose
```

**It earned its keep on the first run**, twice over:

- It reproduced §7's predicted "yo-self is right, TS is stale" divergence as a
  tree diff instead of an assertion — `src/init.ts` scaffolded `test "it works",
{…}` (pre-call syntax) and a `deps.yo` comment using `import "./deps.yo"`.
  Both TS templates now match the self-hosted ones, and the `cd <dir>` hint is
  computed the same way on both sides.
- It exposed a harness-vs-tool confusion worth remembering: on macOS `mktemp -d`
  returns `/var/…` while a child's `process.cwd()` reports `/private/var/…`, so
  every path a tool printed relative to its cwd grew a spurious `../../..`.
  Sandbox roots are resolved with `pwd -P`.

The interim guard `gates_fast.sh` **GATE 5** (run `init`, assert the seven
scaffolded files) still stands. Note it asserts _artifacts_, not `rc=0` — the
original `init` bug created the directories and _then_ died.

---

## 2. THE BLOCKER: codegen bugs that only appear once a subcommand is dispatched

**Read this before wiring another subcommand.**

`build_runner.yo`, `fetch.yo` and `install_command.yo` (~2,600 lines) had been
type-checking cleanly while reachable from no subcommand, so **codegen had never
run on them**. Dispatching them from `main.yo` put them in front of the code
generator for the first time and it emitted **17 C errors**. `check ./yo-self`
was green before and after — exactly the trap §1 exists to catch.

**All eight are fixed**, each with a regression test in
`tests/async_await.test.yo`. The first five were one family
([write-up](../../issues/fixed/async-await-in-nested-match-arms.md)):

| bug                                                          | symptom                |
| ------------------------------------------------------------ | ---------------------- |
| `return(<hoisted local>)` in an async body that awaits later | invalid C              |
| sibling/nested matches with awaits → duplicate `case` values | invalid C              |
| `match` on a payload-free enum inside an async body          | invalid C              |
| an awaited result BOUND in two match arms                    | **rc=0, wrong answer** |
| a match-arm binding re-declared by the state-machine load    | invalid C              |

The fourth was the dangerous one: it compiled and ran, and every arm but the
first read a zero-initialised field. Measured on a 45-line reproducer, `A=true
B=false C=true` where all three must be `true`; `execute_node` in
`build_runner.yo` is exactly that shape. The fifth is a case of **yo-self being
more faithful than the reference** — it already had the mechanism (`_shadow_add`
/ `_remove_arm_shadows`), and only `src/` was missing it.

That left 4 errors, which reduced to **three** further root causes — all now
fixed, each with a minimal reproducer in `issues/repros/`:

6. **[Same-named locals in sibling branches of an async body are
   conflated](../../issues/fixed/async-sibling-arm-same-named-locals.md)** — **the
   worst bug of the batch, because one of its three variants is SILENT.** A
   34-line reproducer compiled clean, exited 0, and printed `compile  thing`:
   the second arm's `label` was empty. Two name-keyed mechanisms were at fault
   — the SSA-remapping key (`name:frameLevel`, which cannot tell a reassignment
   from a redeclaration; it now includes the declaration site) and a by-name
   fallback in atom codegen that handed back another variable's state-machine
   field. It also accounted for the `redefinition of 'sub_path'` and
   undeclared-temp errors. **yo-self was already right here** — its fallback
   carried `decl_site` from the bufio slot-alias fix — so only the remapping key
   needed porting.
7. **[A dropped call result on an async early-completion
   path](../../issues/fixed/async-match-arm-early-return-drops-call-result.md)** —
   a `match` used as a definition's RHS with an arm that early-`return`s a
   freshly-constructed value, inside a body that awaits later. Codegen emitted a
   comment where a value belonged. It now emits the call inline, which is what
   the enclosing declaration needs.
8. **A bare-temp statement in a match arm** (variant C of #6's write-up) —
   `generateCaseBody` was the ONE statement emitter without a bare-temp-name
   gate, so a temp the state machine holds as a field was emitted under its
   source name. **yo-self already had the gate**; only `src/` lacked it.

17 C errors → **0**. `build`, `fetch` and `install` are dispatched, and
`tests/cli-cases/pending/` has moved up into the live corpus.

Three of the eight (#5, #6's fallback half, #8) were cases of **yo-self being
more faithful than the reference** — it already carried the mechanism and `src/`
did not. Check yo-self before assuming a divergence means yo-self is wrong.

**The lesson worth keeping is §1's:** all eight bugs sat behind green
`check ./yo-self` runs for as long as the code was reachable from no subcommand.
Type-checking a file proves nothing about the C it generates. Dispatch is the
test.

---

## 3. `module_manager` — done

`src/module-manager.ts` (458 lines) had **no counterpart**; the demand loader,
the cached prelude env, the shared codegen `ExprInfoTable` and std-path
resolution were inline globals in `main.yo`, so every other subcommand needing
to evaluate a `.yo` file would have grown its own copy.

They now live in [`../yo-self/module_manager.yo`](../yo-self/module_manager.yo)
and `main.yo` imports them. `check` and `compile` delegate; `fetch`, `build` and
`doc` call `mm_load_yo_file` — the counterpart of TS's three-line
`new ModuleManager(); loadModule(path); resetAllState()`.

A literal port of the TS class would have been wrong (§7): TS keeps a map of
live `Evaluator`s because it stores annotations ON the AST node, whereas
yo-self keys a side table by expr id and holds the module cache in
`evaluator/module_loader.yo`. Same service, different storage.

---

## 4. `build` is no longer hollow

Two of §5's three false premises are now retired.

**Registry population.** `yo-self/evaluator/builtins/build.yo`'s
`evaluate_yo_build_functions` validated arguments and returned the right
comptime types but populated nothing ("Registry population is deferred"), and
there was no `get_build_registry`/`clear_build_registry`/`swap_build_registry`
at all. All 20 registry-mutating builtins now mutate a module-level global
registry exactly as `src/evaluator/builtins/build.ts` does, including
`declared_options` (so `-Dname=value` overrides a `build.option(...)` default),
`register_module_link` and `register_imported_module`.

**The phantom flag is gone.** `evaluate_build_file` shelled out to
`yo-cli build --serialize-registry` — a flag that does not exist in `src/` — and
parsed the JSON with `_parse_registry_from_json`, which was
`BuildRegistry.new()` and ignored its input. It now clears the registry,
evaluates the build file through the module manager (the builtins populate the
registry as a side effect of evaluation), and reads it back — mirroring
`src/build-runner.ts`, errors deliberately swallowed for the same reason.

**A port infidelity fell out of this.** `fetch.yo` re-declared its own
`BuildGitDependency` while `src/fetch.ts` IMPORTS the type from the build
builtins, so `fetch_all_deps(registry.dependencies)` could not unify two
same-named types. `fetch.yo` now imports it, and `dep.path` is a plain `String`
("" = no subpath) matching TS's `dep.path ? … : …`.

**The corpus now runs, and it found six more `build` bugs.** `build-list-steps`,
`build-run` and `fetch-no-deps` are live cases (they were written before the
subcommands were dispatched; `build-system.test.ts` is 2,075 lines of pure unit
tests whose only on-disk "projects" are one-line stubs, and no test invoked
`yo build` end to end). Every one of these was invisible to `check` and to the
unit tests:

| bug                                                             | how it failed                                      |
| --------------------------------------------------------------- | -------------------------------------------------- |
| shelled out to `yo-cli` resolved through `PATH`                 | picked up an unrelated global package              |
| never created the artifact output directory                     | bare ENOENT                                        |
| `project_dir` empty — `Path.parent()` is Rust-, not node-shaped | wrote to `/yo-out`, EROFS                          |
| the `run:` dependency prefix never applied                      | **built the program, said "run ok", never ran it** |
| `--dry-run` accepted and ignored                                | did a full build                                   |
| `--list-steps` output reformatted                               | stdout divergence                                  |

Two of those are silent — the run step that reports success without running, and
`--dry-run` building for real. Fixing the dry-run branch then exposed a NINTH
compiler bug ([an `if` whose branch awaits, as a `while` body, emitted
nothing](../../issues/fixed/async-if-with-await-in-while-body-emits-nothing.md)),
which is the same lesson §2 ends on: the code had never reached the code
generator.

Getting `build-run` from SELF-FAIL to PASS then took two more, a TENTH and an
ELEVENTH:

- **The `yo build run` SIGSEGV** — sibling match arms binding the same PATTERN
  name (`execute_node`'s `.Artifact` and `.Run` arms both bind `artifact`)
  stored the binding into the FIRST same-named state-machine slot while reads
  used the arm's own slot, so the awaited callee captured NULL. Fixed in both
  compilers; the effect-escape cleanup had the same name-scan defect. See
  [the issue](../../issues/fixed/async-sibling-arm-match-bindings-store-to-wrong-slot.md) —
  it is the FOURTH member of the sibling-arm cluster, and the lesson
  generalizes: any name-based lookup over `stateMachineVariables` is wrong.
- **Child output overtaking parent output** — libc stdout is fully buffered to
  a pipe, so `Building X → …` flushed at exit, AFTER the spawned program's
  own output. `fflush` before spawn in the C runtime. See
  [the issue](../../issues/fixed/spawn-child-output-ordered-before-buffered-parent-stdout.md).
  Invisible on a tty; deterministic under a pipe — precisely what the harness
  compares byte-for-byte.

`build-run` cannot compare stdout line-for-line — see §9.

---

## 5. `doc` — PORTED except `--format html`

**json and markdown are DONE and differential-verified** (2026-08-10):
`get_generic_impl_doc_entries` (evaluator/values/impl.yo), `doc/builder.yo`
(2,600 lines, token + evaluator halves), `doc/render_json.yo` (the
JSON.stringify key-order/omission contract), `doc_command.yo`, the `main.yo`
dispatch, and two differential cases (`doc-json`, `doc-markdown`) producing
BYTE-IDENTICAL doc.json / README.md / module pages / stdout under both
compilers. Wiring it surfaced three more bugs, all fixed with tests:
control characters in string literals emitted invalid C from BOTH compilers
([write-up](../../issues/fixed/c-string-literal-control-chars-emitted-as-unicode-escapes.md)),
std's `eprint` was missing the `unsafe(...)` wrapper its sibling `eprintln`
has, and method signatures lacked TS's `(Receiver) ` prefix (yo-self's Func
type carries no SelfType — the method registry's `self_type` supplies it).

**`--format html`: RESOLVED — landed in P2, 2026-08-10.** The migration route
below is the one that was taken: `markdown_yo` was migrated to current Yo
(1035/1035 fixtures green) and vendored as a submodule, `render-html.ts` was
ported to `yo-self/doc/render_html.yo`, and the `doc-html` cli-case pins the
output byte-identical to TS. The historical analysis is kept because it
records WHY the WASM route was rejected.

Original note follows.

**`--format html`: DEFERRED TO P2 (maintainer decision, 2026-08-10).**
`render-html.ts` renders doc comments through `markdown_yo` — a WASM build of
a **36,000-line Yo library** (`github.com/shd101wyy/markdown_yo`, same
author) whose source pins yo **0.1.18** and no longer parses under the
current compiler (262 paren-less imports, 50 old-style exports, plus ~20
versions of std drift). The self-hosted side cannot load WASM, so real parity
means either migrating the library to current Yo and importing its source
(byte-identical by construction; the repo's `scripts/migrate-*.ts` tools
replay much of the drift), or linking a native static build of the pinned
version (per-platform blobs in the bootstrap). The maintainer chose to settle
this when P2's packaging story lands. Until then `yo-self doc --format html`
reports a clear "not yet supported" error — it does not silently degrade.
For whoever picks this up: the TS loader contract is three C-ABI exports
(`wasm_render(ptr, len, flags)`, `wasm_result_len()`, `wasm_free(ptr)`) from
`markdown_yo/src/wasm_api.yo`, created with `{html: true, fullFeatures: true}`.

The original gap table, for reference — the extraction half was already
ported (`extractor.yo` 587, `render_markdown.yo` 800, `model.yo` 201,
`sections.yo` 185):

| `src/doc/`       | lines | `yo-self/doc/` |
| ---------------- | ----- | -------------- |
| `builder.ts`     | 1564  | missing        |
| `render-html.ts` | 1883  | missing        |
| `render-json.ts` | 25    | missing        |
| `doc-command.ts` | 352   | missing        |

3,824 lines. The default `--format html` path cannot work. Scope it as "port
builder + html/json renderers + wire the CLI", not as a from-scratch port.

Two prerequisites are already in place: `std/encoding/json.yo`'s
`json_stringify_pretty` was a stub that ignored its `indent` and returned the
compact form — it now pretty-prints like `JSON.stringify(v, null, 2)`, which
`--format json` needs for parity; and `std/path.yo` gained `relative_from`
(node's `path.relative`), which both `doc` and `fetch` print paths with.

`builder.ts` is the crux — every format goes through it, and
`render_markdown.yo` is already ported and waiting on it.

### Porting worksheet (surveyed 2026-08-09 — start here when picking this up)

**Evaluator-API correspondence for `builder.yo`:**

| TS (`builder.ts` imports)                                       | yo-self                                                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `typeToString`                                                  | `types/string.yo` `type_to_string` ✓                                                                      |
| `valueToString`                                                 | `value.yo` `value_to_string` ✓                                                                            |
| `isStructType` / `isSourceNamespaceType`                        | `.Struct(...)` with `is_source_namespace` false / true (yo-self has NO separate module type — TS-aligned) |
| `isEnumType` / `isUnionType` / `isTraitType` / `isFunctionType` | `.EnumT` / `.Union` / `.TraitT` / `.Func` (guards in `types/guards.yo`)                                   |
| `StructType.fields`                                             | parallel `field_labels` / `field_types` on the `Struct` variant                                           |
| `TypeField.defaultValue`                                        | **GAP** — yo-self `Struct` carries no field defaults; defaults live in a side-table keyed per function    |
|                                                                 | (`evaluator/types/field.yo` `default_value_expr`); DocField.defaultValue needs that or stays `.None`      |
| `getGenericImplDocEntries` (impl.ts:1830)                       | **NOT PORTED** — the registry exists (`impl.yo` `GenericImplEntry`, `g_impl_registry_keys` /              |
|                                                                 | `g_impl_registry_entry_lists`, `try_match_generic_impl` returning `Option(ArrayList(TypeValue))`);        |
|                                                                 | port `formatGenericImplSignature` + the entry walk on top of it (~100 lines)                              |
| `getReceiverBaseTypeId`                                         | TS = `functionValue.funcId ?? type.id`; yo-self `Struct.constructor_func_id` / variant `id` fields        |
| `moduleValue: StructValue`                                      | the module's `EvalValue.StructVal` from `module_manager.yo` (same value `check`/`compile` use)            |

**JSON parity trap for `render_json.yo`:** TS `JSON.stringify(model)` emits keys
in OBJECT-LITERAL INSERTION ORDER and DROPS `undefined`-valued keys. The Yo port
must build `JsonValue.Object` with exactly builder.ts's literal key order
(e.g. DocFunction: name, doc, signature, parameters, returnType, typeParams,
effects, isMethod, selfType, returns, errors, deprecated, examples — `effects`
is ALWAYS undefined in TS today, so it never appears) and omit `.None` fields.
`json_stringify_pretty(v, 2)` is already parity-verified.

**Token-scanning half of builder.ts** (`extractTraitImplsFromTokens`,
`extractImplInfoFromTokens`, `extractTraitBodyMembers`, `sliceTokenText`, …)
needs only `token.yo` — no evaluator. It is ~700 lines of the 1,564 and can be
ported and unit-checked first.

**Per-parameter metadata for `buildDocFunction`:** yo-self's `TypeValue.Func`
carries labels in `meta` (`FuncMeta.param_labels` / `forall_labels`) but NO
per-param comptime bit or default value — those ride func-id-keyed side tables
in `evaluator/types/function.yo`: `get_func_param_comptime(func_id)` and
`get_func_param_defaults(func_id)`, keyed by `meta.origin_id`. Token struct is
`{kind, value, row, column, character, module_path, input}` — `sliceTokenText`
maps to `input.substring(start.character, end.character + end.value.len())`.

**Struct methods (TS `structType.trait`):** yo-self attaches nothing to the
Struct TypeValue; inherent/trait methods live in the `type_trait_methods.yo`
registry keyed by type id (`MethodEntry`). `extractMethods` must query that
registry instead of walking a `trait` field.

**Escape trap:** `"\0"` in a DOUBLE-QUOTED Yo string is a lex error (JSON
unescaping); `` `\0` `` in a backtick template string works.

**Order:** ① `get_generic_impl_doc_entries` into `evaluator/values/impl.yo` —
**DONE 2026-08-09** (`GenericImplDocEntry` with parallel
`method_names`/`method_types`, `_format_generic_impl_signature`,
`_receiver_base_type_id_for_doc`, `_type_name_for_doc`; exported, type-checks);
② `doc/builder.yo` (token half, then evaluator half); ③ `doc/render_json.yo`
(model→JsonValue mirroring the literal orders); ④ `doc/render_html.yo`;
⑤ `doc_command.yo` + `main.yo` dispatch + a `tests/cli-cases/doc-*` case
(compare `doc.json` + html tree in the differential).

---

## 6. Suggested order

1. ~~Fix §2's codegen bugs, dispatch `build`/`fetch`/`install`, move
   `tests/cli-cases/pending/` up one directory.~~ **DONE** — all eight bugs
   fixed in both compilers, the three subcommands are dispatched, the corpus is
   live, and `compile yo-self/main.yo` is clean.
2. ~~**`doc`** (§5).~~ **DONE**; html deferred to P2 by maintainer decision
   (§5).
3. ~~**Flag parity for the pre-existing subcommands.**~~ **DONE for `test`,
   `check` and `fmt`** (2026-08-10): all three now reject unknown options
   (TS's yargs is `.strict()`, yo-cli.ts:1348) and accept every flag the TS
   command defines. `test` consumes `--cc/--c-compiler`, `--target`,
   `--test-batch-size`, `--keep-generated-files/-k`, `--disable-sanitize`,
   `--json-summary` and `--profile` for CLI compatibility without acting on
   them yet — accepted divergence, same precedent as `--parallel`.
   Deliberately still NOT done: rewriting `compile`'s ~30-flag parser is the
   highest-regression-risk edit in the CLI and every bootstrap gate depends
   on it; `std/cli/arg_parser.yo` adoption remains the eventual fix.
4. **`--parallel` in the self-hosted test runner.** Still ignored ("v1 runs
   sequentially"). `std/process/command.yo` has no `spawn`/`Child` API — only
   blocking `output()`/`status()` — so implementing it means adding one to
   `std` first. Document it as an accepted divergence until then; the
   self-hosted runner is already ~2× faster than TS sequentially.
5. **`version` — defer to P3.** Today's version cache downloads from **npm**,
   and that channel dies with P2/P3; re-point it at GitHub Releases then.

---

## 7. `fmt` — done, 0 divergent files

**`SELF_HOSTING_COMPLETION.md` says ~315 files. That is stale: it is 0.**

Three root causes, all fixed:

1. The `Dot` case ate the space the Comma/operator handler had just set
   (339 → 253).
2. The self-hosted formatter **destroyed** any file mixing a multi-byte
   character with a backtick string (253 → 17) — a character index used as a
   byte offset in `read_raw_template_string`.
   [write-up](../../issues/fixed/yo-self-formatter-corrupts-files-with-non-ascii.md)
3. **The same class again, in `_trim_trailing_h_ws` (17 → 4).** It walked a
   byte index down from `bytes.len()` and handed it to `String.substring`,
   which is CHAR-indexed — so for any buffer already containing a multi-byte
   character the cut point landed past the last character, `substring` clamped
   to the whole string, and the trim became a silent **no-op**. That is the
   entire "stray space before `)`" class: `(== )`, `(.. )`, `(..= )`,
   `quote(&& )`, C-variadic `... )`. It looked like a "multiline paren frame"
   rule and never reproduced in an ASCII repro _because the repro was ASCII_ —
   the trigger is a non-ASCII character EARLIER in the output, typically an em
   dash in a doc comment.
4. The last 4 were a missing indent: `codegen`-style `write()` in TS indents
   whenever it is at line start, and yo-self's closer/comma/semicolon handlers
   pushed their token directly, so a `,` landing after a trailing line comment
   came out at column 0.

**Reproduce the count** (~25 min):

```bash
for f in $(find std tests yo-self -name '*.yo'); do
  cp "$f" /tmp/a.yo; cp "$f" /tmp/b.yo
  ./yo-cli fmt /tmp/a.yo >/dev/null; "$S1" fmt /tmp/b.yo >/dev/null
  cmp -s /tmp/a.yo /tmp/b.yo || echo "$f"
done | wc -l
```

**The gate is landed** as `gates_fast.sh` GATE 6. It does NOT run the 25-minute
`cmp` loop: the repo is kept TS-`fmt`-clean, so any file the SELF-HOSTED
formatter reports under `fmt --check` is a divergence, and that runs in under a
minute. The gate asserts the TS side is clean FIRST — otherwise "self-hosted
reports 0" would stop meaning "the two agree" the moment the repo drifted. The
`cmp` loop above stays as the slow confirmation.

---

## 8. Method notes that saved real time

Carried forward, plus what this pass added.

- **A green `check` says nothing about codegen.** §2 is the second time this
  has cost a day. `check ./yo-self` passed over 2,600 lines that the code
  generator had never seen. Only running the thing tells them apart.
- **A compile that "succeeded" in a `cmd1 && cmd2 || cmd3` chain may not have.**
  A background build reported exit 0 while its C compile had failed, because the
  `||` branch ran and succeeded. Grep the log for `error:`, do not trust `$?`
  through a chain.
- **`YO_DEBUG_SWALLOW=1`** prints every def-time error yo-self swallows.
- **A green count can be hollow.** Probe with an injected `assert(false)` before
  believing any "N passed" from the self-hosted runner.
- **Check the exit code without a pipe.** `cmd | tail; echo $?` reports _tail's_
  status.
- **A faithful port of a TS _registry lookup_ is often wrong.** TS reads values
  off the type/expr; yo-self resolves through a global table keyed by
  `type_key(t)`. The literal port compiles and silently returns nothing.
- **Two same-named types unify with nobody.** "Cannot unify incompatible struct
  types: `BuildGitDependency` and `BuildGitDependency`" means a file re-declared
  a type its TS counterpart IMPORTS. Check the TS import list before believing a
  local declaration is intentional.
- **A char index used as a byte offset is a SILENT no-op, not a crash.** Twice
  now in the formatter (§7). `String.len()` and `substring` are CHARACTERS;
  `as_bytes()`/`bytes_len()`/`byte_at` are BYTES. An ASCII test corpus hides
  every instance.
- **RC changes need an emit diff, not a green suite.**
- **Before calling CI red "infra"**, read the job log.
- **An error token inside a function body says nothing about WHO evaluated it.**
  Split the reproducer — definition ALONE vs definition + one call.
- **One swallowed error hides a STACK of bugs.** "Still fails after a correct
  fix" is the expected intermediate state.
- **`-fsanitize=function` adjudicates ABI mismatches on arm64.**
- **Scripted `.yo` edits can silently match nothing** after `yo-cli fmt` reflows
  the file. Assert the replacement count.
- **A test body is batched into a file that already binds `io`.** A helper
  parameter named `io` inside a test fails with "variable shadowing is not
  allowed" — name it `rio`/`aio`.
- Never run two heavy jobs at once on a 16 GB box.

---

## 9. Known debt — tracked, not blocking

- **`-fsanitize=function` as a standing guard** — proposed after the `ctl` ABI
  fix, not yet enabled.
- **`std/process/command.yo` has no `spawn`** — see §6.4.
- **`tests/internal/` has no tests for `module_manager.yo` or `fetch_command.yo`.**
  Every other CLI module (cache, fetch, init, install_command, lock_file,
  pkg_config, version) has one; these two are new and covered only indirectly, by
  `check ./yo-self` and by `compile`/`check` exercising the loader on every run.
- **`yo build` forwards only a subset of an artifact's compile options.**
  `yo-self/build_runner.yo` shells out to the compiler with `--target`, `--cc`,
  `--sysroot`, `--extern` and `--include`. `src/build-runner.ts` compiles
  in-process and passes far more: `optimize`, `allocator`, `defines`,
  `libraryPaths`, `libraries`, `sanitize`, `strip`, `static`, `shared`,
  `staticLibrary` and `cflags`. A `build.executable(...)` that sets any of those
  is silently built without them. `tests/cli-cases/build-run`'s fixture sets
  none, which is why the case passes — extend the fixture when closing this.
- **`build-run` cannot compare stdout line-for-line**, because the two compilers
  emit different (equivalent) C and clang's diagnostics carry different line
  numbers. The case uses the harness's `stdout_keep` filter to assert the lines
  that ARE comparable (the built program's own output, the build's step lines,
  any error) rather than `stdout=ignore`, which would assert nothing.
- Open compiler issues live in [`../issues/`](../../issues/); none block P1.
