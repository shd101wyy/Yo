# yo-self never registered `c_include` headers for extern fns — every self-emitted binary leaned on the hardcoded platform includes

**Status: FIXED (2026-08-10).** Found by the std-resolution rework: the first
self-hosted stage-2 emit containing `std/env.current_exe()` failed clang with

```
error: call to undeclared function '_NSGetExecutablePath'
```

because `#include <mach-o/dyld.h>` was missing from the emitted C — while the
TS compiler emitted it correctly.

## Root cause — two stacked gaps

1. **The header was never recorded.** TS stores it on the extern function's
   type (`FunctionType.cInclude`, set in `c-include.ts:141`) and codegen
   collection reads it (`collection.ts:20-23`). The yo-self port documented
   this as skipped ("`cInclude` (a codegen concern) stays skipped" —
   `evaluator/exprs/c_include.yo` header), and the single
   `register_extern_function` call site hardcoded
   `c_include : Option(String).None`.
2. **Extern registration itself never fired.** TS reaches its
   `else if (functionType.isExtern === "c")` registration whenever the callee
   VALUE is not a function value — and `c_include`/extern symbols hold an
   **UnknownValue**. The yo-self port routed only the `.None`-callee-value
   case to extern registration; `.Some(UnknownVal)` fell into a
   `true => ()` catch-all. So `context.extern_functions` was **permanently
   empty** self-hosted.

Both were masked for the entire porting campaign because `emit_c_includes`
unconditionally emits `<unistd.h>`, `<sys/stat.h>`, `<sys/random.h>` (POSIX)
/ `<windows.h>`, `<bcrypt.h>`, `<io.h>` (Windows), the base emitter adds the
C-standard headers, and the sys-runtime C templates carry their own
`#include` lines — and because header-provided prototypes made the (also
never emitted) extern declarations unnecessary. `<mach-o/dyld.h>` was the
first `c_include`d header covered by none of those.

## Fix

`FuncMeta` carries no `c_include` field (adding one would touch all 13
FuncMeta constructors and risk the type-intern merge dropping it), so the
port uses the established side-table pattern (like default-args and
macro-expansion):

- `evaluator/exprs/c_include.yo`: `g_extern_c_includes : HashMap(String, String)`
  — recorded at the FFI-marker stamping site (extern symbol name → header),
  read via the exported `get_c_include_for_extern`.
- `codegen/functions/collection.yo`: the extern-registration block extracted
  into `_register_extern_fn_callee`, now called from BOTH the
  `.Some(non-func-value)` and `.None` callee-value arms (TS parity), and it
  passes `get_c_include_for_extern(c_name)` instead of `None`.
- With registration now live, the emitted declarations follow the already-
  ported `declarations.yo` rules (extern "c" **with** an include → skip, the
  header declares it; without → emit).

**Leak note:** unlike TS, yo-self's collection walk DOES see the
comptime-eliminated platform branch (self-hosted Linux cross-emits gained
`#include <mach-o/dyld.h>`; TS emits 0 refs). Handled the way TS handles its
own type-walk leaks — the emit filter sets in `c/collection.{ts,yo}` grew a
macos-only set (`<mach-o/dyld.h>`, skipped when the target is not macOS),
added to BOTH compilers.

## Residual gap (documented, not fixed)

`CodegenTypeEntry.c_include` (the TYPE-level counterpart, TS
`collection.ts:9-14`) is still never supplied self-hosted. Harmless today:
every `c_include` module that declares opaque types also declares functions
from the same header, so the fn-level registration covers the header.
