# Emitted C keeps user local names — a local named `near` breaks the Windows target

**Status: FIXED 2026-08-22 — option 1 (mangler blocklist) implemented.**
`_build_c_reserved_words` (src/codegen/utils/index.yo) now includes the
legacy Windows macro set (`near far pascal cdecl IN OUT OPTIONAL interface
small hyper`), so `sanitize_for_c_identifier` renames such locals to
`__yo_c_reserved_<name>` — with the existing extern-C escape hatch keeping
real C symbols untouched. Verified red-first on the emit (bare `near` ×2
pre-fix → `__yo_c_reserved_near` ×2, zero bare, post-fix) and gated by
tests/basic.test.yo "locals named after Windows macros survive codegen",
which runs on every CI platform including the windows legs.

**Found:** 2026-08-22 by PR #218's `test (windows-latest)` leg: the
cross-emitted `cross/yo-windows-x64.c` failed with
`error: expected expression` at `if (near) {`. `near` (and `far`,
`pascal`, …) are legacy Win16 macros that `windef.h` defines to NOTHING,
so any user local with one of those names compiles fine everywhere except
a Windows-headers translation unit, where it macro-expands away.

The immediate instance (a `near :=` local in `src/lsp/completion.yo`) was
renamed. The general hazard remains: codegen emits user locals under their
source names, so the collision class is any identifier that some target's
system headers `#define`.

## Possible fixes (pick one when it recurs or in a codegen pass)

1. Blocklist in the C name mangler: locals named `near|far|pascal|IN|OUT|
   OPTIONAL|interface|small|hyper` (the classic Windows macro set) get a
   suffix in emitted C. Cheap, targeted.
2. `#undef` the known macro set at the top of the emitted prelude for
   windows targets. Cheapest, but fights any vendored header that
   re-includes windef.h later.
3. Mangle ALL user locals (e.g. `u_<name>`): total fix, but churns every
   emit and the fixpoint baseline at once.

Until then the authoring rule is in the syntax cheatsheet: avoid
Windows-macro names for locals.
