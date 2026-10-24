# A `--std-path` directory whose name does not end in `std` rejects std's own prelude

**Severity:** S3 — a std tree copied to a directory not named `…std` cannot compile anything; the error blames std's `unsafe :: impl(…)` instead of the path

**Status:** OPEN
**Found:** 2026-10-25, gating `vbd/alloc-v2-gen-a` with a copy of the Generation B std at `tmp/v2lib`.

## Symptom

Copy any std tree to a directory whose name does not end in `std` and compile
a hello world against it:

```sh
cp -r std /tmp/yo-lib-copy
cat > /tmp/hello.yo <<'EOF'
{ println } :: import("std/fmt");
main :: (fn() -> unit)(println("hi"));
export(main);
EOF
yo compile /tmp/hello.yo --std-path /tmp/yo-lib-copy --skip-c-compiler
```

```
error: "unsafe" names a builtin: every call with this name dispatches to the builtin, so a user binding could never run. Choose a different name.
    --> /tmp/yo-lib-copy/prelude.yo:246:1
    |
246 | unsafe :: impl({
    | ^^^^^^
```

The same copy at `/tmp/mystd` or `/tmp/badstd` compiles (rc 0), because the
check is a string suffix test.

## Root cause

The reserved-builtin binding gate exempts the prelude by spelling, not by
the std root: `!tok.module_path.ends_with("std/prelude.yo")`, in three twin
sites:

- `src/evaluator/exprs/binding.yo` (the `name : Type` gate)
- `src/evaluator/exprs/initialization_assignment.yo` (`::`, `(x : T) =`, `:=`)
- `src/evaluator/exprs/destructuring_assignment.yo`

Every other std exemption already asks `is_std_module_path(mp, ctx.std_path)`
(`src/evaluator/memory_safety.yo`), which compares against the resolved std
root and does not care what the directory is called.

## Fix direction

Replace the suffix test with "this module is `prelude.yo` directly under the
std root": `is_std_module_path(mp, ctx.std_path)` plus a `prelude.yo` basename
check (or a canonical comparison against `<std_path>/prelude.yo`). The fix's
regression test compiles a program against a std copy in a directory not
named `…std` (a cli-case can copy the bundled std into its sandbox).

## Related

- `issues/std-path-exemptions-are-lexical-so-tmp-symlink-breaks-them.md`:
  the other way a std root's spelling defeats an exemption.
- The allocator interface switch (`std_allocator_abi_is_v2`,
  `src/codegen/utils/index.yo`) recognizes std's `AllocatorVTable` by the
  module that minted its struct id, under the std root, so it does not
  share this limitation; the evaluator's vtable-call recognizer
  (`_msp_allocator_slot`, `src/evaluator/effects/mutation_summary.yo`) still
  matches a struct-id prefix (`struct_decl_std__prelude_`), which a std
  directory not named `std` also misses.
