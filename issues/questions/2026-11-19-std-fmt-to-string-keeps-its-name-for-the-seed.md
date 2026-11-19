# `std/fmt/to_string.yo` keeps its snake_case name in v0.2.79: the template-literal desugar imports it by path

Kebab-case Part C (`plans/backlog/KEBAB_CASE_NAMES.md`) renames every multi-word module file in std, src and tests.
One file cannot move in v0.2.79: `std/fmt/to_string.yo`.

## Why

The parser desugars a module that holds a template literal by injecting a statement
`import("std/fmt/to_string")` (`import("std/fmt/format")` when a format spec is used) at the top of the module
(`src/parser.yo`, `Parser.get_program`). The path is a string inside the compiler, so it is fixed in each released
binary:

- CI's stage 1 is the SEED (v0.2.78) compiling `src/` against the tree's `std` (`--std-path ./std`). Every `src/` file
  with a template literal makes the seed import `std/fmt/to_string`. The Part C dry run (2026-11-19) failed there
  after 21 s: `Module not found: tried ".../std/fmt/to_string.yo"`, reported at `src/main.yo:1:1`.
- The tree's own parser injects the same path, so every program the tree compiler builds needs the file too.

The plan's "no Generation A/B split is needed: imports are strings" holds for every other module. It does not hold
here, because this import is written by the compiler, not by a source file.

`scripts/kebab-part-c.sh` therefore renames the file with everything else and then moves it back (step 2b). Its
contents and its own imports (`../collections/array-list`) are migrated; only its name and the strings naming it are
restored. In a checkout, `yo check` warns about this one std file until it moves.

## Options for moving it

1. **One release with both files.** The tree parser injects `std/fmt/to-string`, std ships `to-string.yo` and a
   one-line forwarding `to_string.yo` (`{ ToString, Debug } :: import("./to-string.yo"); export(ToString, Debug);`) for
   the seed, and the forwarder is deleted one release later. That release carries an old name in the shipped std,
   which VERDICTS-67 ("no old-name table, not even for one release") argues against, although the forwarder is a
   seed gate rather than a resolver alias.
2. **Make the injected import name-stable first.** The parser injects `import("std/fmt")` (its `index.yo` re-exports
   `ToString` and `Debug`) in one release. The next release, whose seed injects `std/fmt`, renames the file with no
   forwarder. The cost is that every module with a template literal then evaluates `std/fmt/index.yo`, which imports
   `../string`, `./format.yo`, `./spec.yo` and `../libc/stdio`. That is a wider import closure for method visibility,
   and a new cycle risk from `std/string` modules that hold template literals; both need measuring.
3. **Inject no path at all.** The desugar reaches `ToString` through the prelude, or through a builtin that names the
   trait directly. This is the largest change, and it removes the problem for any future std rename.

## Recommendation

Option 2. Land the desugar change (inject `import("std/fmt")`) in v0.2.80 as a Generation A, gated on a run of the
language suite and a `check ./std` RSS/time A/B. Then rename `std/fmt/to_string.yo` in v0.2.81 with
`yo fix std --module-names`, which needs no forwarder and no old name. If the cycle check fails, fall back to option 1,
with the forwarder living exactly one release. v0.2.79 ships with the hold-back described above.
