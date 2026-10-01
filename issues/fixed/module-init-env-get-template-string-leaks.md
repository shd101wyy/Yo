# A module-init `env.get(\`TEMPLATE\`)` leaks its RC String in every test binary that imports the chain

**Severity:** S3 (51 bytes per process; invisible outside LeakSanitizer, but
it fails every `tests/internal` test whose import closure reaches the module)

## The verbatim error

```
==1372971==ERROR: LeakSanitizer: detected memory leaks

Direct leak of 40 byte(s) in 1 object(s) allocated from:
    #0 ...malloc...
    #1 __yo_rc_alloc
    #2 __yo_rc_alloc_scoped
    #3 __yo_new___yo_t_1462724968366066556        // ArrayList(u8) ctor (a String's buffer)
    #4 yo_id_1096..._rtparam0_usize_ret_..._u8    // with_capacity(cap)
    #5 yo_id_13315041371582602487000000           // String.from(__yo_str)
    #6 yo_id_7231319812671811767000000            // str -> String (.to_string())
    #7 __yo_main_module_init
    ...
Indirect leak of 11 byte(s) ...                     // "YO_DEBUG_MG" itself
```

## Minimal reproducer

Any `.test.yo` whose import closure reaches `src/codegen/utils/index.yo`
(e.g. `import("../../src/codegen/chunk_assembly.yo")` — nothing under
`tests/internal` imported that chain before 2026-10-01, which is why the
suite was green):

```rust
{ String } :: import("std/string");
{ assert } :: import("std/assert");
import("../../src/codegen/utils/index.yo");
test("probe", { assert(true, "ok"); });
```

`yo test <file> --parallel 1` fails the test on the leak above.

## Root cause

`src/codegen/utils/index.yo`'s module-init snapshot

```rust
(g_debug_mg : bool) = cgu_env.get(`YO_DEBUG_MG`).is_some();
```

used a backtick TEMPLATE — a runtime RC `String`. `env.get` is
`fn(generic(K), name : K, where(K <: ToString))`, so a plain `str` literal is
accepted and needs no allocation; the template minted a heap String (and the
`Option<String>` machinery around it) as a module-init temporary that no
scope-end drop released. Module-level annotated assignments do not get the
begin-block scope-end drop treatment, so the temporaries of their initializer
live until process exit — reachable from nothing.

## Fix

Pass the static `str` literal instead of the template (the `env.get`
generic already accepts it):

```rust
(g_debug_mg : bool) = cgu_env.get("YO_DEBUG_MG").is_some();
```

Zero allocation at module init; the probe above goes green. Regression net:
`tests/internal/line_directives.test.yo` imports the chain
(`chunk_assembly.yo` → `utils/index.yo`) and fails the whole batch under
LeakSanitizer before the fix.

Found while landing `--line-directives`
(plans/reference/LINE_DIRECTIVES.md): the new internal test was the first
under `tests/internal` to import the codegen utils chain.
