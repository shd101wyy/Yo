# Kebab-case package, directory and file names

> **Status (2026-11-19):** Parts A (#1686, v0.2.74) and B (#1790, 2026-11-05) are done. Part C ships in v0.2.79 as the last step before the cut (maintainer, 2026-11-19), regenerated on the release tip by `scripts/kebab-part-c.sh`. VERDICTS-67 replaced the `--migrate module-names` mode with a permanent `yo fix <path> --module-names` flag that never retires (the tool paragraph below).

**Status:** decided 2026-10-30 by the maintainer, on Fable consultations #3 (package names, 2026-10-29) and #9
(module file and directory names, 2026-10-30).
- Part A is in progress: the package-name tooling and `markdown-yo` land in v0.2.74.
- Part B is done (2026-11-05; the maintainer lifted its deferral): the example repositories are renamed and this tree
  names them in kebab-case. `markdown-it-yo`'s migration PR merges after v0.2.75.
- Part C is part of the VBD campaign (maintainer, 2026-11-06; until then it waited for the campaign's end). It was
  planned as the last PR of the v0.2.78 window (`plans/handover/VBD_RELEASE_SCHEDULE.md` §5f decision 32), did not
  land there, and ships in v0.2.79 as the last step before the cut (maintainer, 2026-11-19). Its tool is the permanent
  `yo fix <path> --module-names` (VERDICTS-67), not a retiring `--migrate` mode.

Until Part C lands, the tree keeps its snake_case module files. The current convention text still says so
(`.github/skills/yo-syntax/syntax-cheatsheet.md` "Naming conventions", `docs/en-US/DESIGN.md` "Naming Convention",
and their zh-CN pages). Part C changes it.

## The rule

Every name that is only ever a string, and never an identifier, is kebab-case:
- package names (`[package] name`, dependency keys, `yo add --name`);
- `.yo` file names;
- directory names;
- `[modules]` keys.

Identifiers keep their styles: functions and variables `snake_case`, types and traits `PascalCase`, constants
`UPPER_SNAKE_CASE`.

- **`-` and `_` are different names.** Nothing normalizes one into the other. A package, file or directory name may
  contain `[A-Za-z0-9_-]` (E1506 for packages).
- **No leading or trailing `-`.** A name like `-foo.yo` would be read as a command-line flag (`yo check -foo.yo`).
- **One separator per import string.** Today `import("markdown-yo/block_parser")` mixes the two separators, and a
  wrong guess is a hard resolve failure. After Part C it reads `import("markdown-yo/block-parser")`.
- **A whole-module binding is still an identifier:** `array_list :: import("std/collections/array-list");`. This
  friction is small in practice: 2 of 203 whole-module bindings in src, std and tests name a multi-word stem, because the
  tree destructures almost everywhere (`{ ArrayList } :: import(…)`).

**Why kebab-case:** a Yo module path is only ever a string. It is an `import(…)` argument, a `[modules]` key, a
`yo context`/`yo doc` module name and a build artifact file name. The compiler never derives an identifier or a symbol
from it. Ecosystems that force snake_case files do so because the path becomes an identifier: Rust `mod foo_bar;`,
Python `import foo_bar`, Gleam/Elixir/Nim module atoms. Yo is in the string-import group with JS/TS, Zig and Odin, and it
already chose kebab-case for package names, which consultation #3 decided on the same argument.

## Breakage audit (consultation #9, origin/develop `a8e93166a`, yo 0.2.73)

A scratch project exercised:
- a kebab file, and a kebab directory with an `index.yo`;
- kebab `[modules]` keys, a kebab package and a kebab path dependency;
- a kebab `*.test.yo`.

It passed `check`, `compile`, run, `test`, `build`, `doc` (Markdown and HTML), `context`, `fmt` and `--emit-chunks`.
None of the following derives an identifier from the file stem, and none mishandles `-`:
- **Resolution and cache keys:** string joins plus `<path>.yo` xor `<path>/index.yo`; the keys are `file://<abs>`.
- **C names:** `yo_id_N` ids; any non-`[A-Za-z0-9_]` byte is escaped by `_mangle_c_identifier_bytes`.
- **`--emit-chunks`:** chunk files are named after the output base (`<base>_chunkNNN.c`).
- **Build artifacts:** `bin/my-app`, `libblock-parser.a`.
- **The test runner:** it discovers `*.test.yo`, and test names come from `test("…")`.
- **`yo doc`:** HTML spells `/` as `__`; anchors are item names.
- **`yo context`:** module names are paths.
- **The LSP:** import-path completion lists directory entries verbatim.

Windows accepts `-` in file names. The only shell hazard is the leading `-`, which the rule bans.

## Part A — package names (v0.2.74)

- **The Yo PR, `feat/package-names-kebab`:**
  - `yo init` emits kebab-case names (`My_App` → `my-app`);
  - one shared `[A-Za-z0-9_-]+` check covers `[package] name`, dependency keys and `yo add --name` (E1506);
  - the compiler's dependency is `markdown-yo` (`yo.toml`, `yo.lock`), the README links are updated in both locales,
    and `AGENTS.md` gets a "translate as you read" line.
- **markdown-yo (done 2026-10-30):**
  - The repository was renamed `markdown_yo` → `markdown-yo`, and v0.0.22 carries `[package] name = "markdown-yo"`.
  - The release archives, the CLI binary and the WASM files became `markdown-yo-*` (markdown-yo #23, released as
    v0.0.23).
  - npm refused `markdown-yo` as "too similar to existing package `markdown_yo`" (its punctuation-similarity rule, which
    applies to the same owner too). The npm package is therefore **`@shd101wyy/markdown-yo`**, published from v0.0.24
    (markdown-yo #24, the maintainer's choice). `markdown_yo` stays on npm, deprecated with a pointer to it.
  - v0.0.23 exists only as a GitHub release.

## Part B — the other example projects (done 2026-11-05)

**Done.** On 2026-11-05 the repositories were renamed and migrated: `raylib-yo` (released v0.0.8), `tetris-yo` (Pages
at `https://shd101wyy.github.io/tetris-yo/`), `http-server-demo-yo`, `markdown-it-yo` (its migration PR merges after
v0.2.75) and, beyond the original scope below, `yo-http-benchmark`. This tree's READMEs, both `BUILD_SYSTEM.md`, the
`yo add`/`yo remove`/`yo update` help examples, the manifest and lock-file header examples and `AGENTS.md` (a
"translate as you read" line) use the new names. The test fixtures under `tests/internal/` keep `raylib_yo` as data
(`toml_edit` tests that an underscore key stays bare).

The original plan:

`raylib_yo` → `raylib-yo`, `tetris_yo` → `tetris-yo`, `markdown_it_yo` → `markdown-it-yo` and `http_server_demo_yo` →
`http-server-demo-yo`, together with every reference to them in this tree (README in both locales, both
`BUILD_SYSTEM.md`, the `yo add`/`yo remove`/`yo update` help examples, the manifest and lock-file header examples). They
were deferred on 2026-10-30 by the maintainer ("rename them to kebab-case after we finish the whole VBD campaign").
- GitHub redirects git URLs after a rename, but not Pages URLs (the `tetris` demo).
- raylib goes first (tetris depends on it).
- Each repository gets one commit fixing its manifest, build file and README, plus a release.
- The runbook from Part A applies: `~/Workspace/Yo-wt/v0273/RENAME_RUNBOOK.md` step 3.

`yo_http_benchmark` is out of scope: it is not a `_yo` package.

## Part C — module file and directory names (v0.2.78, inside VBD)

**Timing (2026-11-06):** the last PR of the v0.2.78 window, after decision 49's S2 sweep, S3 and G3 have merged
(`plans/handover/VBD_RELEASE_SCHEDULE.md` §5f decision 32). Renaming about 120 `src/` files conflicts with every open
branch, so it lands once the campaign's last large sweeps are on develop and nothing is stacked on it. Until
2026-11-06 it was planned as one PR after the campaign.

**No Generation A/B split is needed:** imports are strings, and stage 1 builds with `--std-path ./std`, so std and
src renames land in one commit.

**Size (measured 2026-10-30):**
- about 120 `src/` files and 11 std files with multi-word names; `tests/*.test.yo` are optional, since nothing imports
  them;
- about 1,300 import strings in src, std and tests. 916 of them name a multi-word std module:
  - 684 `std/collections/array_list`, 127 `hash_map` and 69 `hash_set`;
  - 14 `fmt/to_string`, 7 `btree_map`, 6 `ordered_map`, 4 `priority_queue`;
  - 2 `string_builder`, 2 `cli/arg_parser` and 1 `encoding/html_char_utils`;
- 176 distinct `./…` targets inside src;
- 8 `scripts/bootstrap/known-failing.tsv` rows;
- 9 skill references, 19 + 19 docs references and 1 workflow reference;
- the cli-case goldens whose diagnostics quote std paths;
- markdown-yo and every downstream package, the same day.

`plans/` and `issues/` keep their text. `AGENTS.md` gains a "translate as you read" line (`array_list` ⇒ `array-list`).

**The tool: `yo fix <path>... --module-names`** (VERDICTS-67, 2026-11-19; it replaced the `--migrate module-names` mode
this paragraph first planned). It is a permanent, explicit, opt-in flag outside the `--migrate` family, and it never
retires. For every `.yo` file or directory under the paths whose name contains `_` or upper case, it computes the
kebab-case name (`_` → `-`, ASCII lower case, a leading or trailing `-` dropped; no CamelCase splitting) and renames it
on disk. It then rewrites everything that RESOLVES to the renamed file:
- every `import("…")` string;
- every `[modules]` value and key;
- every `build.yo` `root :` path.

Resolution goes through `resolve_module_path` rather than a textual search, so `./foo_bar.yo`, `pkg/foo_bar` and
`foo_bar/index` all move. The tool is idempotent and prints the rename map so downstream packages can apply it.
- `--dry-run` prints the rename map without touching disk.
- A name whose new spelling already exists, or two names that become one, is refused before anything is written.
- A case-only rename takes two steps (through a temporary name), for case-insensitive filesystems.
- It is not folded into the plain `yo fix` repair loop: a `Repair` is a single span, and that loop skips files that
  evaluate.
- There is no old-name table, not even for one release. An import of a renamed module is a hard error with a
  permanent, generic repair instead: when exactly one existing module matches the failed path under segment-wise
  `_` → `-` plus lower-case normalization, the error carries help and a `Repair` on the import string; with zero or
  several candidates, help only (VERDICTS-67 point 2; not cut-blocking).

**In this tree (v0.2.79):** `scripts/kebab-part-c.sh <yo-binary>` regenerates the whole rename on a tip: the two
`_expr.yo` files become `dispatch.yo` first (their kebab spelling `expr.yo` collides with a sibling), then the tool runs
over `src std tests scripts build.yo` (test files included: nothing imports them, but the warning would fire on every
one), then `std/fmt/to_string.yo` goes back to its name (the seed hold-back: the v0.2.78 seed's template-literal desugar
injects `import("std/fmt/to_string")`, so the seed cannot build the tree without it; the tree's desugar injects
`import("std/fmt")`, so v0.2.80 renames the file with no forwarder;
`issues/questions/2026-11-19-std-fmt-to-string-keeps-its-name-for-the-seed.md`), then a textual sweep applies the printed map to what the tool cannot see — comments, Markdown outside `plans/` and
`issues/`, workflows, shell scripts, `known-failing.tsv`, cli-case goldens and string literals that hold a path.

**Enforcement: a warning, never an error, and never `yo fmt`.**
- `yo check` and `yo compile` warn once per project-local `.yo` file or directory name (under the nearest manifest, and
  std) that contains `_` or an upper-case letter, with the `yo fix <root> --module-names` hint.
- Exempt: dependencies in the content store, `tests/origins/corpus`, `issues/repros` and cli-case fixtures.
- A file name is a git-level fact, so the compiler points and does not refuse. `fmt --check` formats contents and
  cannot rename files.

**Convention text to change with Part C:**
- `.github/skills/yo-syntax/syntax-cheatsheet.md` "Naming conventions" (deleted with the shipped skills by K4,
  2026-11-17; the convention went to `.github/instructions/yo-syntax.instructions.md` "Module imports" and
  `pack/context.md` instead).
- `docs/en-US/DESIGN.md` "Naming Convention", `docs/zh-CN/DESIGN.md`, and every docs example that names a multi-word
  module path.
