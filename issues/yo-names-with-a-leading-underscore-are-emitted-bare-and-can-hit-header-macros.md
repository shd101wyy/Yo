# Yo names with a leading underscore are emitted bare and can still hit header macros

**Severity:** S3 — a Yo local, parameter or field whose name begins with `_` and matches a header
macro (`_LP64`, `_NSIG`, `_IOFBF` on glibc; `_U`, `_L`, `_N`, `_P`, `_X` in newlib's `<ctype.h>`)
is replaced by the preprocessor; the C fails to compile, or computes with the macro's value.

**Found:** 2026-10-02, reviewing `fix/header-macro-prefix`
(`issues/fixed/emitted-c-identifiers-collide-with-header-macros.md`).
**Status:** OPEN.

## Cause

`sanitize_for_c_identifier(name, false)` (`src/codegen/utils/index.yo`) gives every Yo-derived name
the prefix `__yo_v_`, except names `_is_compiler_shaped_identifier` treats as compiler-generated:
EVERY name beginning with `_`. That test is what keeps the rule idempotent and leaves temps
(`_<n>_temp_<n>`, `_<module>_temp_<n>`), `__yo_*` and byte-mangled pieces (`_u42_`) alone, but a
user's own `_`-prefixed name (the usual spelling of an unused binding) passes through it too.

Measured on glibc 2.40 (`cc -dM -E` over `<stdio.h>`, `<stdlib.h>`, `<string.h>`, `<math.h>`,
`<pthread.h>`, `<errno.h>`, `<ctype.h>`, `<signal.h>`, `<time.h>`, `<unistd.h>`,
`<sys/socket.h>`): the object-like macros of the form `_[A-Z]\w{0,5}` are `_IOFBF`, `_IOLBF`,
`_IONBF`, `_LP64`, `_NSIG`; the only `_[a-z]…` ones are the function-like `_tolower`/`_toupper`
(they only expand when followed by `(`). Longer `_SC_…`/`_PC_…`/`_POSIX_…` names exist by the
hundred. newlib's `<ctype.h>` defines the one-letter `_U`, `_L`, `_N`, `_S`, `_P`, `_C`, `_X`,
`_B`.

Identifiers beginning with `_` and an upper-case letter are reserved to the implementation in C,
so a Yo program that uses one as a local is relying on the compiler to rename it.

## Fix direction

Recognise the compiler's generated shapes precisely instead of "any leading `_`": a leading `__`
(`__yo_*`, the prefix itself), the temp shapes from `src/utils.yo`, and the `_u<byte>_` mangling.
Then a user `_x` gets `__yo_v__x`. Every generated `_…` name that reaches the sanitizer must be
enumerated first: one the narrower test misses is declared prefixed and used raw, which the
compiler's own stage-2 C (fixpoint) names.
