# The lexer rejects a source file starting with a UTF-8 BOM — surfaced by install.ps1's verification step

**Fixed 2026-08-28.** Two bugs in one report; both fixed in the same pass.

## Symptom

Running `scripts/install.ps1` on Windows 11 under **Windows PowerShell 5.1**
(`powershell.exe`) fails at the post-install verification step, and the failure
presentation itself is broken — a raw `NativeCommandError` at the invocation
line instead of the script's own `Fail` message:

```
PS C:\Users\shd10\Workspace\Yo> .\scripts\install.ps1
...
Verifying (compiling a hello world)..
yo.exe : check: error in: Error: Variable "锘縪pen" not found.
所在位置 C:\Users\shd10\Workspace\Yo\scripts\install.ps1:405 字符: 10
+   $log = & $exe compile $src -o $out 2>&1
    + CategoryInfo          : NotSpecified: (check: error in...pen" not found.:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
```

`锘縪pen` is the tell: `锘`/`縪` are the GBK rendering of the bytes
`EF BB BF 6F` — a UTF-8 BOM glued onto `open`. Reproduced directly:

```
$ printf '\xEF\xBB\xBF' > tmp/bom.yo   # + the installer's hello-world body
$ yo compile tmp/bom.yo -o tmp/bom.exe
check: error in: Error: Variable "﻿open" not found.
yo: error: compile: failed to evaluate module "tmp/bom.yo"
```

(the control file without the BOM compiles and runs).

## Root causes

1. **`install.ps1` wrote the hello-world source with a BOM.**
   `Verify-Install` used `'@ | Set-Content -Path $src -Encoding UTF8`, and on
   Windows PowerShell 5.1 `-Encoding UTF8` ALWAYS prepends `EF BB BF` (PS 7's
   `utf8` is BOM-less; that encoding-name behavior change is the whole
   Windows/CI gap). CI never saw this because `install-scripts.yml` runs the
   script under `shell: pwsh` — the same class of miss as the Windows-SDK
   probe note already in the script (`Test-CToolchain`): the runner
   environment is not a user environment.

2. **The Yo lexer absorbed U+FEFF into the first token.** `tokenize`
   (`src/lexer.yo`) had no BOM handling, so the decoded BOM rune became part
   of the first identifier (`﻿open`), which then fails evaluation with
   `Variable "﻿open" not found`. rustc, Go and clang all strip a leading
   UTF-8 BOM; Windows tooling (PowerShell 5.1, several editors) emits them,
   so the compiler should tolerate one.

3. **(presentation) The script died at the `2>&1` capture instead of its own
   error path.** With `$ErrorActionPreference = 'Stop'` in force, Windows
   PowerShell 5.1 turns the first line a native command writes to stderr
   under `2>&1` into a TERMINATING `NativeCommandError` at the call site —
   so `yo`'s legitimate stderr output hijacked the script before the
   `$LASTEXITCODE -ne 0` branch could print its friendly message. The same
   landmine sat in `Test-CToolchain`'s clang probe and in the run of the
   compiled hello world (a clang warning on stderr would have killed the
   script the same way).

## Fix

- `scripts/install.ps1`:
  - `Verify-Install` writes `hello.yo` with
    `[System.IO.File]::WriteAllText($src, $hello)` — .NET's default is UTF-8
    WITHOUT BOM on every PowerShell generation. The verification runs against
    RELEASED binaries, which cannot be assumed to tolerate a BOM, so the
    script must stay BOM-less regardless of the compiler-side fix.
  - All three native `2>&1` captures (`Test-CToolchain`'s clang probe,
    `Verify-Install`'s compile and run) drop to
    `$ErrorActionPreference = 'Continue'` for the duration of the capture so
    stderr lines land in `$log` and the script's own handling runs.
- `src/lexer.yo` `tokenize`: while filling the `char_indices()` lists, a rune
  that starts at byte 0 and is U+FEFF is skipped. Byte 0 only — a U+FEFF
  elsewhere stays an ordinary identifier rune, matching rustc's single-BOM
  strip. Rows, columns and `character` are then as if the file had no BOM;
  `byte_offset` still counts the 3 BOM bytes so token text slices of `input`
  stay correct.
- `tests/internal/lexer.test.yo`: two regression tests — "Leading UTF-8 BOM
  is skipped, not lexed into the first token" (kind/value/row/column/
  character/byte_offset of the first token) and "BOM-only input tokenizes to
  an empty stream".

## Verification

- Red/green at the lexer level (batch binary run directly — the runner's
  Windows failing-child bug, see
  `issues/yo-test-failing-child-windows-unknown-io-error.md`, hides ✗
  reports): with `src/lexer.yo` reverted to HEAD the two tests print
  `value must be 'open' with no BOM rune` / `expected 0 tokens` and exit 127;
  with the fix the runner reports `2 passed`.
- `yo check ./src` 262/262; `yo build` green; the built binary compiles AND
  runs the BOM'd hello world (`tmp/bom.yo` → `hello`, rc=0).
- Full `tests/internal/lexer.test.yo`: 47/47 with the patched binary.
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1`
  (PS 5.1, v0.2.19 already cached): `Verified: compiled and ran a hello world.`
  rc=0 — the exact reported scenario, green end-to-end.
