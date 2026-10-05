# The test runner prepends the ASan DLL directory to PATH once per batch

**Severity:** S2 — on Windows with AddressSanitizer on, `yo test` grows PATH by one copy of the clang ASan runtime directory per test batch, so a long run eventually hands child processes a PATH they can no longer search ("'ping' is not recognized").

**Status: FIXED (2026-10-05).** Found by the first CI battery on PR #1200's
merged tree (run 37292720878, `test (windows-latest)`). This PR re-armed ASan
on windows-x64 (`issues/fixed/windows-images-lost-libasan.md`), which made the
path reachable in CI for the first time.

## Symptom

About 200 batches into the language suite, `tests/process/command.test.yo`
"a child-stdin write larger than the pipe buffer does not park the event loop"
failed:

```
'ping' is not recognized as an internal or external command,
operable program or batch file.
'findstr' is not recognized as an internal or external command,
operable program or batch file.
unexpected exception (at file://D:/a/Yo/Yo/std/assert.yo:39:17)
```

Every earlier Windows command test in that file uses only cmd builtins
(`echo`, `exit`, `type`, `for`), so it is the first one in the run that needs
`cmd` to search PATH. The same file passes on windows-11-arm, where ASan is
still off (`--disable-sanitize`), so this code path never runs there.

## Root cause

`src/main.yo` puts the directory holding `clang_rt.asan_dynamic-<arch>.dll`
on PATH in two places: in the compile command's ASan probe, and in the test
runner before each batch's children. Both did
`proc_env.set("PATH", "${dll_dir};${cur_path}")` with no presence check. The
test runner runs it once per batch, so PATH gained a ~50-byte entry for every
batch: about 10 KB of duplicates on top of the runner image's already long
PATH by the time `tests/process/` ran. The link to the symptom is inferred:
the unbounded growth is certain from the code, and the failure is the first
PATH search after it. The CI battery that runs this fix confirms it.

## Fix

`windows_path_with_dir_first(path, dir)` puts `dir` first unless an entry
already names it, comparing as Windows does (ignoring ASCII case and a
trailing `\`). Both sites go through `_put_asan_dll_dir_on_path`. Test:
`tests/internal/compile.test.yo` "the ASan DLL directory goes on PATH once,
however many batches apply it". It applies the helper 200 times and requires
one entry. The pre-fix shape, a plain `${dir};${path}` prepend, fails it.
