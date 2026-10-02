# Emitted C identifiers collide with macros from included headers

**Severity:** S1 — Yo identifiers can collide with header macros — C failure, or silent computation with the macro's value

**Found:** 2026-09-24, building the compiler with a new helper in `src/evaluator/calls/function.yo`
(Phase 2.4 of `plans/TYPE_SYSTEM_SOUNDNESS.md`).
**Status:** FIXED 2026-10-02 (`fix/header-macro-prefix`): every Yo-derived local, parameter,
field and enum payload member is emitted under the prefix `__yo_v_` (see "Fix" below).
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

## Decision: prefix every Yo name, not a longer deny-list

A narrower rule (prefix only names that collide with a known macro set) was
considered and rejected:

- The set is not knowable when the C is emitted. The original symptom's macro
  (`ub_name`) comes from a header the PROGRAM chose (`c_include` of OpenSSL),
  not from the runtime; any `c_include` brings an arbitrary macro set, and the
  runtime's own set differs per target and per libc version (glibc, musl,
  macOS, MinGW, MSVC's `<windows.h>` with its lower-case `near`/`far`/`small`/
  `interface`). Collecting it would mean preprocessing every included header
  with each target's compiler (`cc -dM -E`) at compile time.
- The deny-list was one macro short twice already (Windows, then OpenSSL).
- A macro that expands to something that still parses compiles a different
  program, so "the C compiler will tell us" is not a safety net.

A reserved prefix needs no knowledge of any header: identifiers beginning
with `__` belong to the implementation, and nothing defines `__yo_v_…`.

## Fix

`sanitize_for_c_identifier(name, false)` (`src/codegen/utils/index.yo`) now
emits a Yo-derived name as `__yo_v_<name>`. Compiler-generated shapes keep
their spelling, which also makes the rule idempotent (several call sites
sanitize a name twice): names beginning with `_` (temps, `__yo_*`, the prefix
itself, Box's `_u42_`), `fn_yo_id_…`, `yo_id_…`, `closure_yo_id_…`, `var_…`
(state-machine locals), and numeric literals (a leading digit: some atom paths
hand `i32(1)`'s `1` through the variable-name function). Alongside it:

- `c_symbol_name(s)`: the old behaviour (byte mangling plus the C-keyword
  deny-list, no prefix) for names that are an ABI or a fragment: exported and
  extern "Yo" function names (`functions/collection.yo`), function ids
  (`function_c_name`), pieces of type and static names (`Array_<elem>_<n>`,
  `Iso_<child>`, `__yo_typeid_<type>`).
- `c_field_name(owner, label)`: a struct ADOPTED from a header
  (`Point : Type` naming a Yo struct, docs/en-US/FFI.md) keeps the header's
  member spelling; used by property access, value-struct literals, comptime
  struct values and struct patterns.
- `c_variant_member_name(variant)`: an enum's payload member in its `data`
  union is a Yo name too (`data.__yo_v_Some.__yo_v_value`), at the union
  declaration and at every access, including the hard-coded `Option` payloads
  of `downcast` and `JoinHandle.await`.
- Sites that pasted a raw Yo name next to a sanitized declaration now spell
  it the same way: closure and `io.async` capture-struct literals, every
  `sm->__capture.<name>` access, effect-bundle access paths, the `self`
  reference of the auto borrow assert, `generate_assignment`'s returned name,
  the await/state/JoinHandle result names.
- Lookups keyed by emitted names use the emitted spelling: the match shadow
  set (`local_shadowed_variables`), `already_in_scope` in `_materialize_arg`,
  and `dyn()`'s value temp (an atom's `variable_name` is the Yo name, so the
  raw comparison redeclared `T __yo_v_err = __yo_v_err;` and read `.data = err`
  — the only class the compiler's own stage-2 C surfaced).

Residual gap (open, S3): a user's own name that begins with `_` is treated as compiler-shaped
and stays bare, so `_LP64`/`_NSIG` (glibc) or newlib's one-letter `<ctype.h>` macros (`_N`, `_L`)
still collide: `issues/yo-names-with-a-leading-underscore-are-emitted-bare-and-can-hit-header-macros.md`.

LSP, `yo doc` and diagnostics never print emitted C names (no `src/lsp/`, `src/doc/` or
diagnostics path calls the spelling functions), so they are unaffected. A debugger shows a Yo
local as `__yo_v_<name>`.

The `_c_reserved_words` deny-list now only guards `c_symbol_name` and
compiler-shaped names (`_Bool`).

The rule for codegen authors is in `.github/instructions/c-codegen.instructions.md`
("Spelling a Yo name in C").

## Cost (MEASURED 2026-10-02, Linux x86_64, the compiler's own stage-2 C)

The prefix changes the spelling of every Yo name, so every emitted program changes; the
fixpoint still holds (stage 2 == stage 3, `FIXPOINT_HOLDS`). To isolate the prefix, the stage-2
C was compared with the same file with every `__yo_v_X` rewritten back to its old spelling
(`X`, or `__yo_c_reserved_X` for a deny-listed name), which is what develop's codegen emits for
the same tree:

| | prefixed | old spelling | delta |
| --- | ---: | ---: | ---: |
| stage-2 C bytes | 140,813,737 | 133,110,825 | +7,702,912 (+5.8%; 1,100,416 occurrences × 7 bytes) |
| clang `-fsyntax-only`, user CPU, 3 runs | 30.24 / 31.00 / 30.97 s | 29.32 / 32.14 / 31.02 s | none measurable (means 30.74 vs 30.83 s) |
| clang `-O2` binary | 12,981,680 B | 12,978,704 B | +2,976 B (+0.02%: global symbol names) |

`-O2` wall time was measured too (640 / 976 s prefixed, 1082 / 1086 s old spelling) but the
machine was shared with several other builds (load average ~16), so those numbers carry no
signal beyond "not visibly slower".

## Test (red before, green after)

- `tests/basic.test.yo`, "locals, parameters and fields named after header macros are plain
  names" and "payload fields, object fields and closure captures named after header macros":
  locals, parameters, struct fields, enum payload fields, a `ref(struct)` field named `obj` (the
  constructor's own local), a struct destructure and a closure capture named after `<stdio.h>`'s
  `EOF`/`BUFSIZ`/`FILENAME_MAX` (the runtime includes it on every target) and after the lower-case
  `ub_name`/`yo_hm_count` that `tests/header_macro_names.h` defines exactly as `<openssl/asn1.h>`
  does.
- `tests/async_await.test.yo`, "io.async captures and locals named after header macros": an
  `io.async` capture and state-machine locals named `EOF`/`BUFSIZ`/`FILENAME_MAX`, sync and across
  two awaits.
- `tests/c_include_struct_by_value.test.yo` (existing) pins the adopted-struct exemption: its
  fields keep the header's spelling.

Red before: both tests, extracted to standalone programs, fail to compile with the v0.2.48 seed
(`expected member name or ';' after declaration specifiers`, `expected a field designator`,
`expected ')'`: 20 and 16 clang errors). Green after with the fixed compiler.

## Survey that preceded the fix (2026-09-29, every `sanitize_for_c_identifier` site read)

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
