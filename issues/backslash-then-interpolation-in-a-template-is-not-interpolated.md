# A backslash immediately before `${...}` in a template suppresses the interpolation

**Severity:** S3 — the template silently produces a LITERAL `${name}` (and drops the backslashes) instead of interpolating, so path-building code quietly computes a nonexistent path

- **Status**: OPEN (one of the two affected sites was fixed on branch
  `s3/batch-0-fixes` because the ASan restore depended on it — see
  ["Affected sites"](#affected-sites); the other is a degraded error
  message below)
- **Found**: 2026-10-03, restoring Windows ASan
  (`issues/fixed/windows-images-lost-libasan.md`): the runner's
  ASan-DLL discovery had NEVER found the directory, on any machine, since
  the day it landed.

## The semantics (measured 2026-10-03, v0.2.49-tree compiler)

```rust
v := String.from("VV");
t1 := `a\\${v}b`;   // "a${v}b"  — NOT interpolated, backslashes gone
t2 := `a\${v}b`;    // "a${v}b"  — same
t3 := `a\\b`;       // "a\b"     — escape itself works
t4 := `C:\\x\\${v}\\y`; // "C:\x${v}\y" — backslashes fine elsewhere
```

Any `${` whose `$` is preceded by a backslash (one or two) is emitted
literally and the backslash(es) before it vanish. A template with no
backslash before the interpolation interpolates normally, so the trap only
bites Windows-style path strings — exactly the strings nobody re-checks.

## Affected sites (whole-tree survey 2026-10-03: exactly two)

1. `src/main.yo`, `_find_clang_asan_dll_path` —
   `` win_lib := `${clang_lib}\\${vname}\\lib\\windows` `` built
   `...\clang\${vname}\lib\windows`, `exists()` said false, and the
   discovery returned `.None` everywhere. The Windows test legs never
   noticed because pre-2026-09-03 their mingw gcc's ASan runtime was
   already on PATH. FIXED on `s3/batch-0-fixes` by concatenating:
   `` `${clang_lib}\\` + vname + String.from("\\lib\\windows") ``.
2. `src/evaluator/values/char.yo` — the lexer's bad-escape diagnostic
   `` `Unknown escape sequence: \\${esc_str}` `` prints
   `Unknown escape sequence: ${esc_str}` instead of naming the escape.
   The fix is the same restructure (`` `Unknown escape sequence: \\` +
   esc_str ``); gate it with a message assertion in
   `tests/internal/lexer.test.yo` (tokenize a `"\\q"` string and assert
   the message contains `\q`).

## Recommendation

The LEXER rule is the deeper question: `\\` should be an escaped backslash
and leave the following `${...}` free to interpolate (t1 above shows the
current grammar instead consumes the pair and emits the interpolation
source literally). Changing that is a language decision with compat
implications — until it is taken, the working idiom is to interpolate a
separator variable (`sep := String.from("\\")`, `` `a${sep}${v}` ``) or to
concatenate around the backslash runs, and grep for the pattern
(`\${` preceded by a backslash) whenever a Windows path is built in a
template. The yo-syntax cheatsheet should carry this pitfall.
