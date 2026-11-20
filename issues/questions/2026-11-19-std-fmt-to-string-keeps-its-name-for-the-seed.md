# `std/fmt/to_string.yo` keeps its snake_case name in v0.2.79: the template-literal desugar imports it by path

**Kind:** design question

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

Option 2, moved one release earlier, as the verdict below records. v0.2.79 itself makes the injected import name-stable,
and v0.2.80 renames the file with no forwarder and no old name.

## Verdict (2026-11-20, coordinator): option 2, in v0.2.79

The v0.2.78 seed matters only while it builds the v0.2.79 tree. `std/fmt/to_string.yo` still exists under that name in
v0.2.79, so the seed's injection keeps resolving. The v0.2.79 parser injects `import("std/fmt")` (`src/parser.yo`
`get_program`). Stage 2, the v0.2.79 release, and therefore the v0.2.80 seed all inject the package path, never the file.
A template that uses a format spec still injects `import("std/fmt/format")`, whose name is already kebab-case.

Precondition, checked:
- `std/fmt/index.yo` re-exports `ToString` and `Debug` from `./to_string.yo`, and `Format` from `./format.yo`.
- The injection binds no name. It only loads the module so that the `ToString` impls register, and `std/fmt` loads
  `to_string.yo`, so the same impls register through the same resolution.

The one thing in the way was a cycle, and it needed no shim:
- `std/fmt/to_string.yo` was the only module in `std/fmt`'s import closure that held a template literal.
- With the new injection, a load that reached `to_string.yo` first (through `std/error`, for example) imported
  `std/fmt` first, and `std/fmt` destructured `ToString` from the half-loaded module (E0403 `No member "ToString"`;
  simulated with the v0.2.79 tool binary on a scratch std).
- Its twenty template literals are now explicit `String.from` / `push_str` / `append_to` calls, the same calls a template
  lowers to. The module doc records why.

Every other module in that closure is template-free (measured over the 18 files `std/fmt/index.yo` reaches).

**v0.2.80:** `yo fix std src tests scripts --module-names` renames `to_string.yo` to `to-string.yo` along with every
import of it. Then drop step 2b of `scripts/kebab-part-c.sh`, or retire the script, since the rename is done.
