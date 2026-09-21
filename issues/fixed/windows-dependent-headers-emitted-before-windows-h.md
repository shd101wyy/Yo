# A Win32 header that depends on `<windows.h>` can be emitted before it

**Status:** FIXED 2026-09-21 (branch `fix/warm-type-ids-identity-namespace`).
Found by cross-emitting a new `<psapi.h>` binding for
`x86_64-pc-windows-msvc` before merging it.

## Symptom

`yo compile … --target x86_64-pc-windows-msvc --emit-c` put the dependent
header first:

```
#include <stddef.h>
#include <psapi.h>
#include <windows.h>
```

`<psapi.h>` is written against `DWORD`, `HANDLE`, `BOOL` and `WINAPI`, all of
which `<windows.h>` defines. Compiling that translation unit fails on MSVC and
on mingw; it is an error, not a warning. The Windows CI leg would have gone
red on the first program that registered such a header.

## Root cause (measured)

`emit_c_includes` (`src/codegen/c/collection.yo`) emitted the registered
include set by iterating `context.c_includes`, a **HashSet**, and only then
appended the platform block that includes `<windows.h>`, `<bcrypt.h>`,
`<io.h>` and `<sys/stat.h>`. A hash order has no relation to the dependency
order C requires, so any `c_include("<psapi.h>", …)` landed ahead of the
`<windows.h>` at the end. `<bcrypt.h>` and `<io.h>` were only ever safe
because the platform block emits them AFTER its own `<windows.h>`.

The set also already contained `<windows.h>` (registered by
`std/libc/windows.yo`), so a Windows emission carried it twice — harmless
because of the header guard, but it hid how load-bearing the trailing copy
was.

## Fix

The ordering decision moves into a pure function, `ordered_c_includes`, which
takes the registered list and the two platform flags and returns the emission
order:

1. `<windows.h>` first when targeting Windows, and skipped later in the list
   so it appears exactly once;
2. then the registered set in its own iteration order, with the
   platform-incompatible headers filtered out as before;
3. then the platform's file-op headers.

Non-Windows emission is unchanged element for element, so no host golden and
no byte-identity gate moves. Windows emission changes only by `<windows.h>`
moving to the front and losing its duplicate.

The rest of the order stays UNSORTED on purpose: sorting would rewrite every
program's emitted C to fix a problem only the Win32 family has.

## Regression test

`tests/internal/c_include_order.test.yo` drives `ordered_c_includes` with a
registered list whose first element is `<psapi.h>` and whose third is
`<windows.h>` — the exact hash order that broke — and asserts `<windows.h>`
is first, that every dependent Win32 header follows it, that it appears once,
that the platform filters still drop what they dropped, and that the
registered set's own order is preserved rather than sorted.
