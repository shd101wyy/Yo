# Every non-ASCII character a program prints mojibakes on a legacy-code-page Windows console

**Status:** FIXED 2026-10-04 (branch `windows-console-utf8-cp`)
**Severity:** S3 — wrong display only (no data corruption: the bytes on pipes and in files are always correct UTF-8), but it hits every CJK-locale Windows user out of the box, for the compiler CLI and every compiled program alike
**Found:** 2026-10-04, running `yo explain E0902` in pwsh on a zh-CN Windows 11 box.

## Reproducer

Any Yo output containing a non-ASCII character, on a console whose code page is a
legacy ANSI page (GBK 936 on zh-CN, Shift-JIS 932 on ja-JP, …) — the default on
localized Windows unless the user opted into the "Use Unicode UTF-8 for
worldwide language support" beta:

```
C:\Users\shd10\Workspace\Yo [develop ↓12 +2 ~0 -0 !]> yo explain E0902
E0902 鈥?cannot reassign
...
Example 鈥?this fails:
```

`yo` emits the em dash `—` (U+2014) as the 3 UTF-8 bytes `E2 80 94` (verified
with `od -c`). The console decodes those bytes with code page 936: `E2 80` maps
to `鈥`, and `94` is a GBK lead byte that pairs with the following space as an
invalid sequence — both replaced by one `?`. That is why the space after the
dash disappears too (`鈥?cannot`, byte-exact proof of the mechanism). The same
happens for any program printing `println("中文")` — Yo is self-hosted, so the
compiler binary and user programs share the runtime.

Git Bash/mintty, VS Code terminals set to UTF-8 and machines with the system
UTF-8 beta enabled display the same bytes correctly; the bytes piped to a file
are always correct. Only the interactive console render is wrong.

## Cause

The generated C runtime never calls `SetConsoleOutputCP`/`SetConsoleCP` — the
whole tree has no reference to them. Whatever bytes a program writes to the
console are therefore decoded with the console's active (locale-default, legacy)
code page, while Yo emits UTF-8 unconditionally. The Windows `main` wrapper
(`generate_main_wrapper`, `src/codegen/functions/generation.yo`) sets up the
worker thread and returns, with nothing console-related.

`WIN32_LEAN_AND_MEAN` is defined before `<windows.h>` in every emitted unit, so
`<wincon.h>` (the header declaring the console-code-page functions) is not
pulled in by `<windows.h>` — a fix has to include it explicitly.

## Fix

The Windows arm of `generate_main_wrapper` now brackets the program body with
`__yo_win_console_cp_enter()` / `__yo_win_console_cp_exit()`:

- `enter` saves the console's current input and output code pages and switches
  both to `CP_UTF8`, so the program's UTF-8 output renders and typed input
  arrives as UTF-8. It is a no-op when the pages are already UTF-8 (a parent Yo
  process already switched them — nested `yo test` batches) and when the process
  has no console (redirected/piped runs: `GetConsoleCP()` returns 0).
- `exit` flushes stdout/stderr first (buffered UTF-8 written after the restore
  would decode under the legacy page again) and then restores the saved pages,
  so the fix is scoped to the program's lifetime — the user's shell session
  keeps its configured code page. Abnormal exits (`__yo_abort`) skip the
  restore, same as a `chcp`-typed process that dies.

`#include <wincon.h>` is emitted with the helpers (LEAN_AND_MEAN excludes it
from `<windows.h>`); the four functions live in kernel32.dll, which the wrapper
already links against for `CreateThread`.

Test: `tests/internal/main_wrapper_console_cp.test.yo` drives
`generate_main_wrapper` with a registered `__yo_user_main` for
windows/msvc, posix and wasm targets and asserts the enter/exit bracket is
present in the Windows C and absent from the other arms.
