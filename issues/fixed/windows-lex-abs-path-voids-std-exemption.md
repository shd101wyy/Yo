# Windows: `_lex_abs_path` cwd-joins absolute paths, voiding the std exemptions of the pragma gates

**Status:** OPEN → fixed in the same commit stack as the mimalloc v3.5.1 bump
(`chore/bump-mimalloc-v3.5.0`, PR #181). Found while trying to build the tree
locally on windows-x64 with the v0.2.23 seed.

## Symptom

Every seed-gated build of this tree fails on Windows with a wall of macro-gate
errors, regardless of what is being built:

```
$ yo compile src/main.yo --optimize 2 --allocator mimalloc --std-path ./std
check: error in: Error: Defining a macro (a 'quote(...)' parameter or an
  'unquote(...)' return type) requires 'pragma(Pragma.AllowMacroDef);' at the
  top of the file. See plans/reference/MACRO_POLICY.md.
check: error in: Error: Failed to import module "../collections/array_list.yo":
...
yo: error: compile: failed to evaluate module "src/main.yo"
```

`std/collections/array_list.yo:1022` (`array_list :: (fn(...(quote(elems))) ->
unquote(Expr))`) is the first macro definition the evaluator trips over, but
every std macro-defining file is equally rejected. The same failure hits
`yo check ./src --std-path ./std`. **No Yo release since the `AllowMacroDef`
gate landed can compile this tree on Windows.** CI never noticed: the
seed-gated jobs (`test.yml` suite-candidate, fixpoint, release) all run on
Linux runners.

## Root cause

The std exemption of the pragma gates (`is_macro_def_capable_file`,
`is_overload_set_capable_file` in `src/evaluator/memory_safety.yo`) compares
paths by literal string prefix after absolutizing both sides with
`_lex_abs_path`. That helper recognized only a leading `/` as "already
absolute":

```yo
if(s.starts_with(`/`), {
  return(s);
});
...
.Ok(d) => `${d.to_string()}/${s}`,   // cwd-join everything else
```

On Windows an absolute path is `C:/...` (or a `file://C:/...` URI — after the
scheme strip it is still `C:/...`), which does not start with `/`, so it fell
through to the cwd join and came out as `<cwd>/C:/Users/.../std/...`. The
std-path side absolutized to `<cwd>/std` (relative form) — the prefix never
matched, the exemption silently returned false, and the gate rejected std
files for missing a pragma that std files are not allowed to carry yet
(bootstrap-transitional exemption, `plans/reference/MACRO_POLICY.md` Part 2).

Why `yo compile foo.yo` mostly worked on Windows while `--std-path ./std`
failed: the walk-up std discovery yields an absolute path, and the mangling is
symmetric on BOTH sides (`<cwd>/C:/...` prefix vs `<cwd>/C:/...`), so the
prefix compare accidentally succeeded. Only a RELATIVE std path — exactly what
the repo's own build invocations pass — produced asymmetric shapes.

## Fix

`_lex_abs_path` delegates to `std/path.yo`: strip `file://`, then
`Path.new(...)` — which folds `\` to `/`, recognizes drive-absolute and UNC
shapes in `is_absolute`, and resolves `./`/`../` — then cwd-join via
`Path.join` for relative remainders. Both sides of every prefix compare are
now normalized the same way on every platform. The helper is exported (same
precedent as `_clear_pragma_registry`) so `tests/internal/memory_safety_paths.test.yo`
can unit-test it with synthetic Windows-shaped inputs on any OS.

## Verification

- `tests/internal/memory_safety_paths.test.yo`: Windows-shape assertions fail
  against the unfixed helper (pre-fix run recorded in the PR), pass after.
- `yo check ./src --std-path ./std` (relative form, the failing invocation)
  succeeds on windows-x64 after the fix, with the v0.2.23 seed.
- The seed can again build the tree natively on Windows, which is the
  prerequisite for the `--allocator mimalloc` verification in this PR.
