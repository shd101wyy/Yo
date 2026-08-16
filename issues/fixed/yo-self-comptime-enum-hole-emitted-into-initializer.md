# yo-self emits `/* skip generating value */` inside a C initializer for a comptime-folded ctor with an Unknown payload

**Status: FIXED 2026-08-16** (the `test-wasm32_emscripten` leg's failure on
PR #127 after the imm_map fix — batch 46, `tests/env.test.yo`:
`error: expected expression` at
`.data = { .Err = { .error = /* skip generating value */ } }`).

## Reproducer

`issues/repros/wasm-current-exe-skip.yo` — call `std/env`'s `current_exe`
with a wasm target:

```bash
<stage1> compile issues/repros/wasm-current-exe-skip.yo \
  --release --target wasm-wasi --emit-c --skip-c-compiler -o /tmp/r
grep -c "skip generating value" /tmp/r.c   # was 1, want 0 (TS: 0)
```

Native is clean because the failing arm is wasm-only.

## Root cause

`std/env.yo`'s `current_exe` ends in
`true => .Err(\`current_exe is not supported on platform '${platform}'\`)`.
Under a wasm target the whole `cond(platform == …)` is comptime-decided, and
yo-self's fold left the taken arm's value as an **`EnumVal`whose payload is
an`UnknownVal`** (the template interpolating the comptime `platform`enum
does not fold to a string) with **empty`runtime_arg_exprs_in_order`\*\*.

`generation.yo`'s comptime-value emission gate already had two exceptions for
yo-self-only value shapes (TS produces a bare `UnknownValue` in these spots
and falls through to the call path): a Struct/EnumVal ctor **with runtime
args**. This is the third shape — same family, but with NO runtime args — so
the gate emitted `generate_comptime_value(EnumVal{Unknown})`, whose payload
renders as the `/* skip generating value */` sentinel, straight into a C
initializer. A bare comment in expression position is a C syntax error; the
whole test batch failed to compile. NOTE the direct form
(`.Err(\`…${platform}…\`)`outside a comptime-decided cond,`issues/repros/wasm-err-template-platform-skip.yo`) does NOT reproduce — it
keeps runtime arg exprs and takes the existing exception.

## Fix

`yo-self/codegen/exprs/generation.yo`, the comptime-value gate: after
rendering, a Struct/EnumVal whose rendering contains the skip sentinel falls
through to the expression emitters (cond → ctor → template), which produce
the same runtime string-building TS emits. Detection by the rendered
sentinel rather than a value-shape walk covers arbitrary nesting depth.
