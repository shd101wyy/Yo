# A symlinked `YO_STD` (e.g. macOS `/tmp`) silently loses the std pragma exemptions

**Status:** OPEN
**Found:** 2026-08-24, running a scratch battery with `YO_STD=/tmp/yo-unitfix/std`.
**Severity:** low, but the error message points nowhere near the cause.

## Symptom

With a std tree under a symlinked directory, std's own macro-defining modules
are rejected as if they were user code:

```
$ YO_STD=/tmp/yo-unitfix/std yo test ./tests/collections.test.yo
… macro definition is not allowed here …   (std/collections/hash_map.yo, hash_set.yo)
```

The same command with `YO_STD=/private/tmp/yo-unitfix/std` — the *same
directory*, spelled through the resolved path — works.

On macOS `/tmp` is a symlink to `/private/tmp`, so this is easy to hit any time
a std tree lives in a temp directory (scratch worktrees, CI sandboxes, bootstrap
staging).

## Root cause

`is_macro_def_capable_file` (src/evaluator/memory_safety.yo:153) grants std files
an exemption by comparing the module path against the std root as a **lexical**
string prefix, via `_lex_abs_path` (same file, :136), which explicitly does no
symlink resolution:

```
/// Purely lexical — no symlink resolution — matching how the loaders build
/// std module URIs (a join on the same std root).
```

That assumption holds only when both sides come from the same spelling. They do
not: the std root keeps whatever spelling `--std-path`/`YO_STD` was given
(`/tmp/...`), while a relative module path is absolutized against `cwd()`, which
returns the **resolved** path (`/private/tmp/...`). The prefix test then fails
and the file falls through to `file_has_pragma(..., Pragma.AllowMacroDef)`,
which std files cannot yet carry (the exemption exists precisely because the
pragma is seed-gated — see plans/reference/MACRO_POLICY.md Part 2).

`is_implicitly_unsafe_capable_file` in the same file shares `_lex_abs_path` and
therefore the same hazard.

## Fix options

1. Canonicalize the std root once at startup (resolve symlinks when the path is
   taken from `--std-path`/`YO_STD`), so both sides are in resolved form. This is
   the smallest change and matches what `cwd()` already returns.
2. Resolve both sides in `_lex_abs_path`. More robust, but it makes a per-check
   syscall unless memoized, and the comment above it deliberately avoids that.
3. Leave the mechanism alone and make the diagnostic say so: when a macro-def or
   unsafe rejection fires for a file whose *resolved* path is under the resolved
   std root but whose lexical path is not, report the std-root spelling mismatch.

Option 1 plus the option-3 message is probably the right pair.

## Workaround

Spell `YO_STD` (and `--std-path`) with the resolved path — `/private/tmp/...`
rather than `/tmp/...` on macOS.
