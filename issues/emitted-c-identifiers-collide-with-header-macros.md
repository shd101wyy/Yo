# Emitted C identifiers collide with macros from included headers

**Found:** 2026-09-24, building the compiler with a new helper in `src/evaluator/calls/function.yo`
(Phase 2.4 of `plans/TYPE_SYSTEM_SOUNDNESS.md`).
**Status:** OPEN.
**Class:** valid Yo, invalid C. `yo check` is green; the C compiler fails, or, worse, compiles a
different program.

## Symptom (MEASURED, develop `d735d1f15` + the Phase 2.4 branch)

A Yo local named `ub_name` in the compiler's own source:

```
yo-out/aarch64-apple-darwin/bin/yo.c:1164072:33: error: expected identifier or '('
 1164072 |     __yo_t_12045147821119090033 ub_name = _file____User_temp_100558405997710551321.data.Some.value;
/opt/homebrew/Cellar/openssl@3/3.6.3/include/openssl/asn1.h:269:17: note: expanded from macro 'ub_name'
  269 | #define ub_name 32768
```

The compiler links OpenSSL (`src/main.yo`'s TLS `c_include`), and `<openssl/asn1.h>` defines a
lower-case object-like macro `ub_name`. Any Yo local, parameter or field of that name is replaced
by `32768` before the C compiler sees it.

## Root cause

`sanitize_for_c_identifier` (`src/codegen/utils/index.yo`) emits a Yo identifier verbatim unless it
is on a DENY-LIST (`_build_c_reserved_words`: the C keywords, `errno`/`stdin`/… and, since
`issues/fixed/emitted-c-locals-collide-with-windows-macros.md`, the legacy Windows macros `near`,
`far`, `IN`, `OUT`, …). A deny-list cannot be complete: every header any program `c_include`s —
and every header the runtime includes on each target — may define arbitrary macros, and the set
differs per platform. This is the second time the list was one macro short (Windows first).

A macro that expands to something that still parses is worse than this compile error: the
program silently computes with the macro's value.

## Fix direction

Make the emitted spelling of every Yo-derived identifier (locals, parameters, struct and enum
field names, labels) impossible for a header to define: a reserved prefix such as `__yo_`
(identifiers beginning with `__` are reserved to the implementation, and no third-party header
defines `__yo_…`). Extern C names (`is_extern_c`) keep their spelling, as today. The deny-list
then becomes unnecessary. This is a byte-identity event for the emitted C (fixpoint + goldens).

## Test

A cli-case compiling a program whose local, parameter and struct field are named after a macro
the runtime's headers define on every target (e.g. `EOF`, `BUFSIZ`, `assert`), plus
`ub_name` behind a `c_include("openssl/asn1.h")` gated on pkg-config.
