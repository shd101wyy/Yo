# P1 — CLI parity for the self-hosted compiler

**Handover doc. Start here.** Supersedes
[`archive/PRE_P1_HANDOVER.md`](archive/PRE_P1_HANDOVER.md), whose question
("what must be true before P1 starts?") is answered: nothing is blocking, and
P1 has started.

P1 is defined in [`SELF_HOSTING_COMPLETION.md`](SELF_HOSTING_COMPLETION.md).
This document is the working state: what is done, what its own plan gets wrong,
what order to do the rest in, and the traps that have already cost time.

**Every number here was measured on 2026-08-09, not quoted.** Where this
contradicts `SELF_HOSTING_COMPLETION.md`, this document is the later
measurement — several of its figures are stale and are called out below.

---

## 0. Where P1 stands

|                   |                                                             |
| ----------------- | ----------------------------------------------------------- |
| Hard blockers     | none                                                        |
| Subcommands wired | `check`, `compile`, `test`, `fmt`, **`init`**               |
| Subcommands left  | `build`, `doc`, `fetch`, `install`, `cache`, `version`      |
| `fmt` divergence  | **17** of 808 files (was 339) — one rule class left         |
| Bootstrap         | FIXPOINT_HOLDS, stage-3 byte-identical                      |
| Gates             | `gates_fast.sh` failures=0, 15 required checks on `develop` |

`init` was the first P1 step and it earned its keep on day one — see §4.

---

## 1. Do this first: `scripts/cli-diff-test.sh`

It does not exist, and it is the highest-value thing left.

`init_project` was 239 complete, type-checking lines wired to **no
subcommand**. It had never been executed once. `check ./yo-self` passed it
every time. Wiring it up produced `rc=139` against the reference compiler's
`rc=0` on the very first run.

**In this codebase "ported" can mean "type-checks and is unreachable", and
`check` cannot tell those apart.** Every remaining subcommand is in exactly
that position right now. Build the harness before wiring more of them.

`scripts/diff-test.sh` supplies the verdict vocabulary and exit contract, but
compares only stdout+rc — useless for subcommands whose real output is a
directory tree, a cache mutation, or an artifact set. The new one must diff
trees.

The interim guard already in place is `gates_fast.sh` **GATE 5**: it runs
`init` and asserts the seven scaffolded files. Note it asserts _artifacts_, not
`rc=0` — the original bug created the directories and _then_ died, so an
exit-code check would have passed it.

---

## 2. Then `module_manager` — a prerequisite, not a subcommand

`src/module-manager.ts` is 458 lines with **no counterpart** in `yo-self/`
(verified: `yo-self/module_manager.yo` does not exist). It is the shared
"evaluate a `.yo` file and read its exports/registry" service that `build`,
`fetch`, `install`, `doc`, the test runner and codegen all import.

Most of the remaining subcommands need it. Doing it first stops each of them
from growing its own half-version.

---

## 3. Three premises in P1's own plan are false

`SELF_HOSTING_COMPLETION.md` says the machinery is "ALREADY PORTED as
libraries … the work is CLI wiring + flag parity + differential validation."
True for `init`, `fetch`, `install`, `cache`, `version`, `lock_file`,
`pkg_config`. Not true here:

### `build` is hollow, not unwired

```rust
_parse_registry_from_json :: (fn(json : String) -> BuildRegistry)(
  BuildRegistry.new()          // ignores its input entirely
);
```

…and `evaluate_build_file` shells out to `yo-cli build --serialize-registry`,
**a flag that does not exist in `src/`** (zero grep hits). `yo build` would
build an empty DAG and exit 0. Upstream cause: yo-self's build builtins never
populate the registry ("Registry population is deferred"), and there is no
`get_build_registry`/`swap_build_registry` at all.

**The `build` differential corpus must be WRITTEN, not collected.**
`SELF_HOSTING_COMPLETION.md` says to gather `tests/build-projects/` from
`build-system.test.ts` fixtures. That file is 2,075 lines of pure _unit_ tests
whose only on-disk "projects" are one-line stubs; no test invokes `yo build`
end to end.

### `doc` is missing its render half

The extraction half IS ported — `yo-self/doc/` is 1,773 lines (`extractor.yo`
587, `render_markdown.yo` 800, `model.yo` 201, `sections.yo` 185). What is
missing, verified file by file:

| `src/doc/`       | lines | `yo-self/doc/` |
| ---------------- | ----- | -------------- |
| `builder.ts`     | 1564  | missing        |
| `render-html.ts` | 1883  | missing        |
| `render-json.ts` | 25    | missing        |
| `doc-command.ts` | 352   | missing        |

3,824 lines. The default `--format html` path cannot work. Scope it as "port
builder + html/json renderers + wire the CLI", not as a from-scratch port.

### `module-manager.ts` has no counterpart

See §2.

---

## 4. What `init` taught, and the gate that came out of it

Wiring `init` produced a SIGSEGV whose root cause was not in `init.yo` at all:
the async state machine silently miscompiled `await` under an `if`, emitting a
C **comment** where a state transition belonged and then dereferencing a NULL
future. Compile returned rc=0 and produced a segfaulting binary.

That opened a seam. Six async-codegen bugs were found and fixed across
2026-08-09, two of them silent:

| bug                                        | symptom                 | compilers   |
| ------------------------------------------ | ----------------------- | ----------- |
| `await` under `if` had no state transition | **rc=0, SIGSEGV**       | reference   |
| `match` arm containing an await            | **rc=0, arm never ran** | self-hosted |
| `io.async` capture never RC-retained       | rc=139 in a loop        | self-hosted |
| `return(<compound>)` in tail position      | invalid C               | self-hosted |
| unread await result → missing SM field     | invalid C               | both        |
| capture/future alias matched on name alone | invalid C               | both        |

All six are fixed, each with a regression test;
`tests/async_await.test.yo` is 144/144 under both compilers. Full write-up:
[`../issues/await-in-branch-positions-matrix.md`](../issues/await-in-branch-positions-matrix.md)
and
[`../issues/fixed/yo-self-init-segfaults-on-first-run.md`](../issues/fixed/yo-self-init-segfaults-on-first-run.md).

**`io.await` now works in every conditional position** — `if`/`cond`
conditions, `match` scrutinees, `while` conditions and the 3-arg `while`'s
step. Two shapes are deliberately rejected with a diagnostic naming the fix: an
await _nested_ inside a larger condition, and an await in a _later_ `cond`
branch (hoisting it would break `cond`'s laziness).

---

## 5. Suggested order

1. **`scripts/cli-diff-test.sh`** (§1) — before wiring anything else.
2. **`module_manager`** (§2) — unblocks most of what follows.
3. **`cache` → `fetch` → `install`** — these libraries really are ported, so
   this is wiring + flag parity + differentials.
4. **Finish `fmt` (17 files) and land its gate with the fix** (§6). Not
   cosmetic: at P2 the self-hosted formatter becomes canonical and
   `fmt --check` becomes self-referential, so an un-gated divergence would
   silently restyle hundreds of files with nothing able to notice.
5. **`build`** (§3) — populate the registry, drop the phantom
   `--serialize-registry`, write the corpus.
6. **`doc`** (§3) — the largest single chunk.
7. **`version` — defer to P3.** Today's version cache downloads from **npm**,
   and that channel dies with P2/P3; re-point it at GitHub Releases then, not
   now.

Alongside: **flag parity for the four existing subcommands**. `yo-self` honours
only `--bail`, `--test-name-pattern`, `--exclude`; the arg loop's catch-all
assigns any unrecognized token to `target_path`, so `yo test ./tests --profile`
runs against a path literally named `--profile`. It exits **1** with "file or
directory not found" — loud, not a silent pass (an earlier draft of this
document claimed exit 0; that was a misread `$?` through a pipe).
`--parallel N` _is_ parsed correctly, which matters because the sweep and
measure scripts pass it. `std/cli/arg_parser.yo` (546 lines, tested) already
exists and `main.yo` does not use it — adopting it fixes the catch-all and
gets `--help`/`--version` for free.

The self-hosted test runner also ignores `--parallel` ("v1 runs sequentially") —
implement it or document it as an accepted divergence.

---

## 6. `fmt` — 17 files from done

**`SELF_HOSTING_COMPLETION.md` says ~315 files. That is stale: it is 17.**

Two root causes were fixed, both in _both_ formatters:

1. The `Dot` case ate the space the Comma/operator handler had just set
   (339 → 253).
2. The self-hosted formatter **destroyed** any file mixing a multi-byte
   character with a backtick string (253 → 17). A character index used as a
   byte offset in `read_raw_template_string`; ASCII hid it from every test, and
   `fmt` exited 0 with output that no longer parsed. 23 of 40 sampled `std/`
   files were being corrupted.
   [`../issues/fixed/yo-self-formatter-corrupts-files-with-non-ascii.md`](../issues/fixed/yo-self-formatter-corrupts-files-with-non-ascii.md)

**What remains is ONE class, 17 files**: a stray space before `)` when an
operator token ends a MULTILINE paren frame — `(==)`, `(..)`, `(..=)`,
`quote(=>)`, C-variadic `...`. It does not reproduce single-line, so the
multiline frame is part of the trigger.

Reproduce the count in ~25 min:

```bash
for f in $(find std tests yo-self -name '*.yo'); do
  cp "$f" /tmp/a.yo; cp "$f" /tmp/b.yo
  ./yo-cli fmt /tmp/a.yo >/dev/null; "$S1" fmt /tmp/b.yo >/dev/null
  cmp -s /tmp/a.yo /tmp/b.yo || echo "$f"
done | wc -l
```

`scripts/bootstrap/gates_fast.sh` carries a note where the gate goes. Mind the
caveat recorded there: the TS formatter PRESERVES existing line structure
rather than canonicalizing it, so a naive "would format" count mixes real
spacing bugs with line-breaking differences.

---

## 7. Method notes that saved real time

Carried forward from the pre-P1 handover, plus what P1's first week added.

- **`YO_DEBUG_SWALLOW=1`** prints every def-time error yo-self swallows. It is
  what turned the HOLLOW files from a weeks-scale mystery into a named line.
- **A green count can be hollow.** Probe with an injected `assert(false)` before
  believing any "N passed" from the self-hosted runner. A test file can report
  "N passed" with an empty `__yo_user_main`.
- **Check the exit code without a pipe.** `cmd | tail; echo $?` reports
  _tail's_ status. This produced a false "exits 0, silent pass" reading about
  `yo test --profile` in this very document.
- **A faithful port of a TS _registry lookup_ is often wrong.** TS reads values
  off the type/expr (`type.trait.fields`, `context.types[t.id].cName`);
  yo-self resolves through a global table keyed by `type_key(t)`. The literal
  port compiles and silently returns nothing — that is exactly how the `match`
  arm came to be dropped. Grep `yo-self/codegen/` for `// Error:` emissions:
  each is a candidate silent-drop site.
- **RC changes need an emit diff, not a green suite.** Diff per-function
  incr/decr counts old vs new and confirm only the intended sites moved. A
  `type_key`-keyed `___dup` fallback for async captures removed a segfault and
  returned `n=4640` instead of `n=3` — a loud crash traded for a silent wrong
  answer.
- **Before calling CI red "infra"**, read the job log. A `test-wasm32_wasi` red
  on 2026-08-09 was `curl: (35) Recv failure` downloading wasmtime _before any
  test ran_; CI's exact command run locally passed 2355/2355. But an earlier
  "emsdk 403" was a real regression — check whether another job failed the
  _same test name_.
- **An error token inside a function body says nothing about WHO evaluated it.**
  Split the reproducer — definition ALONE vs definition + one call — before
  instrumenting. One compile each, and it decides def-time vs call-time
  outright.
- **One swallowed error hides a STACK of bugs.** "Still fails after a correct
  fix" is the expected intermediate state. Read WHICH arm the new last
  swallowed error names; a different arm means progress.
- **`-fsanitize=function` adjudicates ABI mismatches on arm64.** Only the
  _consequences_ are x86_64-specific; the cast types live in the emitted C.
- **Scripted `.yo` edits can silently match nothing** after `yo-cli fmt`
  reflows the file. Assert the replacement count, then grep for a token unique
  to the OLD text to prove it went.
- Never run two heavy jobs at once on a 16 GB box; they swap and manufacture
  failures that do not reproduce in isolation.

---

## 8. Known debt — tracked, not blocking

- **`src/init.ts`'s templates are stale.** It scaffolds `test "it works", {…}`
  and `import "./deps.yo"` — pre-call syntax the language moved away from. The
  self-hosted templates are the _more current_ ones. Never caught because CI
  runs `yo build run` and never `yo build test`. This is the predicted
  "yo-self is right and TS is stale" divergence, confirmed.
- **`-fsanitize=function` as a standing guard** — proposed after the `ctl` ABI
  fix, not yet enabled.
- Open compiler issues live in [`../issues/`](../issues/); none block P1.
