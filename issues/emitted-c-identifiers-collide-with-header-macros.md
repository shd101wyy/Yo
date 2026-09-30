# Emitted C identifiers collide with macros from included headers

**Severity:** S1 — Yo identifiers can collide with header macros — C failure, or silent computation with the macro's value

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

## Implementation plan (survey 2026-09-29, every `sanitize_for_c_identifier` site read)

A blanket prefix inside `sanitize_for_c_identifier` breaks the compiler. About 120 call sites
pass it three kinds of name, and callers depend on its current behaviour:

- **Compiler-generated names pass through it unchanged.** Temps (`_<12>_temp_<n>`,
  `src/utils.yo`) are declared through `get_variable_type_string` (sanitized) and used raw
  (e.g. `other_fn_call.yo` returns the raw temp after declaring the sanitized one).
  `function_c_name` sanitizes `yo_id_…`/`fn_yo_id_…`, and `get_variable_name_for_codegen`
  tests `starts_with("fn_yo_id_")` on its output. Temp-shape tests
  (`is_temp_variable_name`, `.contains("_temp_")`) run on sanitized names.
- **It is assumed idempotent**: names are sanitized twice at `init_assignment.yo`,
  `assignment.yo`, `drop_dup.yo` and `exprs/generation.yo`.
- **Declarations and uses do not always go through it together.**
  - Capture-struct fields are declared sanitized but written raw:
    - the closure capture literal (`closures.yo` `.label =`)
    - the `io.async` capture literal (`async.yo`)
    - every async `__capture.<name>` access (`atom.yo`, `state_machine.yo`, `functions/context.yo`, `async.yo`)
    - effect-bundle access paths (`async.yo`)
  - Closure bodies read a capture FIELD through the variable-name function
    (`closure_context->${get_variable_name_for_codegen(name)}`).
  - The shadow set compares a sanitized name against a raw one (`atom.yo`, `return.yo`).
  - `other_fn_call.yo`'s `already_in_scope` compares a raw name with a sanitized declaration.
  - A raw `ExprInfo.variable_name` is emitted as C text at several sites (`await.yo`, `async.yo`,
    `dyn.yo`, `assignment.yo`).

Rules for the prefix (`__yo_v_`, unused today):

1. Idempotent, and a no-op on compiler shapes: names beginning with `_` (temps, `__yo_*`), and
   `fn_yo_id_`, `yo_id_`, `closure_yo_id_`, `var_…` (state-machine locals, already
   `var_<name>_<hash>`, immune).
2. Applied to every Yo-derived LOCAL, PARAMETER and FIELD label, so a capture field and the
   variable it captures keep one spelling. Module globals are already `<name>_m<hash>`.
3. Not applied to extern C names (`is_extern_c`), library export names and extern "Yo" imports
   (`functions/collection.yo`, an ABI).
4. Variant NAMES (union members) are never sanitized today (consistent, but exposed: a variant
   named `EOF` collides). Prefix them in the same change, together with the two hard-coded
   `.Some` (`downcast.yo`, `await.yo`) and the hard-coded Option payload `.value`.
5. The Fn-trait vtable member `call` is hard-coded on three sides
   (`types/generation.yo`, `functions/dyn.yo`, `other_fn_call.yo`). It stays unprefixed and
   exempt.

Bonus: a struct field named `obj`, `box` or `ptr` collides today with the generated constructor's
locals (`obj->f = f`, `functions/constructors.yo`); prefixing fields fixes that too.

Gate: byte-identity is expected to break (every emitted name changes), so the gate is fixpoint
(stage 2 == stage 3) + the full fast suite + cli goldens, plus the test below with macros from
headers the runtime includes on every target.
