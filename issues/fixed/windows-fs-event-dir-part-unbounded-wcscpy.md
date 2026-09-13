# Windows: single-file `fs.watch` copies the watched path into `dir_part[MAX_PATH]` unbounded

**Status: FIXED (2026-09-12).** The non-directory branch of
`__yo_fs_event_start`
(`src/codegen/async/runtime_io_windows.yo`) prepared the parent directory
for `FindFirstChangeNotificationW` with:

```c
wchar_t dir_part[MAX_PATH];
wcscpy(dir_part, wpath);        // wpath is caller-supplied UTF-8→UTF-16
```

`wpath` is the fully converted watch path — a path longer than 260 UTF-16
units smashes the stack. Every sibling call site in the file bounds its
copies (`GetFinalPathNameByHandleW` results are length-checked, `__yo_win_utf8_to_wide`
heap-allocates); this one was missed. Found 2026-09-12 by inspection in
the Windows async-I/O runtime audit (`audit/windows-async-io`); not
reproduced — a >260-char single-file watch path is legal on Windows 10+
(`MAX_PATH` is not the kernel limit), and constructing one deliberately
in a test is brittle across CI configurations.

## Fix

```c
wchar_t dir_part[MAX_PATH];
wcsncpy(dir_part, wpath, MAX_PATH - 1);
dir_part[MAX_PATH - 1] = L'\0';
```

The truncation falls back to watching the truncated prefix — the same
degraded-but-safe outcome the surrounding `MAX_PATH` buffers already
imply. A structural fix (dynamic `wcslen`-sized buffers throughout the
fs-event path) belongs with any long-path work, not this patch.
