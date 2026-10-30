# Kebab-case package, directory and file names

**Status:** decided 2026-10-30 by the maintainer, on Fable consultations #3 (package names, 2026-10-29) and #9
(module file and directory names, 2026-10-30).
- Part A is in progress: the package-name tooling and `markdown-yo` land in v0.2.74.
- Parts B and C wait until the VBD campaign is complete (after v0.2.76; `plans/handover/VBD_RELEASE_SCHEDULE.md` §7).

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

## Part B — the other example projects (after VBD)

`raylib_yo` → `raylib-yo`, `tetris_yo` → `tetris-yo`, `markdown_it_yo` → `markdown-it-yo` and `http_server_demo_yo` →
`http-server-demo-yo`, together with every reference to them in this tree (README in both locales, both
`BUILD_SYSTEM.md`, the `yo add`/`yo remove`/`yo update` help examples, the manifest and lock-file header examples). They
were deferred on 2026-10-30 by the maintainer ("rename them to kebab-case after we finish the whole VBD campaign").
- GitHub redirects git URLs after a rename, but not Pages URLs (the `tetris` demo).
- raylib goes first (tetris depends on it).
- Each repository gets one commit fixing its manifest, build file and README, plus a release.
- The runbook from Part A applies: `~/Workspace/Yo-wt/v0273/RENAME_RUNBOOK.md` step 3.

`yo_http_benchmark` is out of scope: it is not a `_yo` package.

## Part C — module file and directory names (after VBD)

**Timing:** one PR after v0.2.76. Renaming about 120 `src/` files during VBD would conflict with every open campaign
branch; that is the only reason to wait.

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

**The tool: `yo fix <path> --migrate module-names`**, beside the existing `--migrate` family. For every `.yo` file or
directory under the path whose name contains `_` or upper case, it computes the kebab-case name and renames it on disk.
It then rewrites everything that RESOLVES to the renamed file:
- every `import("…")` string;
- every `[modules]` value and key;
- every `build.yo` `root :` path.

Resolution goes through `resolve_module_path` rather than a textual search, so `./foo_bar.yo`, `pkg/foo_bar` and
`foo_bar/index` all move. The tool is idempotent and prints the rename map so downstream packages can apply it. It
retires with the other migrations, one release after it ships.

**Enforcement: a warning, never an error, and never `yo fmt`.**
- `yo check` and `yo compile` warn once per project-local `.yo` file or directory name (under the nearest manifest, and
  std) that contains `_` or an upper-case letter, with the `--migrate module-names` hint.
- Exempt: dependencies in the content store, `tests/origins/corpus`, `issues/repros` and cli-case fixtures.
- A file name is a git-level fact, so the compiler points and does not refuse. `fmt --check` formats contents and
  cannot rename files.

**Convention text to change with Part C:**
- `.github/skills/yo-syntax/syntax-cheatsheet.md` "Naming conventions". This moves the skill-tree cli goldens.
- `docs/en-US/DESIGN.md` "Naming Convention", `docs/zh-CN/DESIGN.md`, and every docs example that names a multi-word
  module path.
