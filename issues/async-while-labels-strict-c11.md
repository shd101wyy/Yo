# Async while labels before declarations: emitted C is not strict C11 (breaks the OHOS clang)

**Status: open — fixed in codegen on `develop`; needs a release to reach users.**

Found 2026-08-22 while validating `scripts/install.sh` HarmonyOS support on a
real HarmonyOS box (HongMeng Kernel 1.13.0, `uname -s` = `HarmonyOS`,
harmonybrew + ohos-sdk clang 15.0.4).

## Symptom

Compiling the published `yo-v0.2.14-linux-arm64.c.gz` with the OHOS clang
fails with a cascade of parse errors:

```
yo.c:2239701:7: error: expected expression
      after_while_loop_0:
      void* _file____home_temp_7726 = ((void*)(sm->var_375677));
            ^
yo.c:2262147:15: error: use of undeclared identifier '_file____home_temp_494024'
yo.c:2260417:15: error: use of undeclared identifier '__yo_sc_yo_id_1275715'
```

The "undeclared identifier" errors are cascades: clang rejects the
declaration line after the label, so every later use of that local is
undeclared.

## Root cause

The async state-machine emitters print loop labels BARE:

```c
while_loop_1_start:
size_t _file____home_temp_1358339 = ...;   // declaration — not a statement
```

In **C11 a label must be followed by a statement** (6.8.1), and a declaration
is not a statement (that only changed in C23, N2508). GCC accepts the pattern
as a GNU extension — which is why the release pipeline's portable-C gate
(`gcc -std=c11 -fsyntax-only -w yo.c`, release.yml:1100) stayed green — and so
does the modern clang the bundles are built with, so no CI leg ever compiled
the emitted C with a strict C11 front end. The OHOS SDK clang 15.0.4 rejects
it in every mode (`-std=c11`, `gnu11`, `gnu17`, default) with
`error: expected expression`, and harmonybrew's `gcc` is a wrapper that execs
the same clang, so there is no compiler-level workaround on HarmonyOS.

Affected emitters (all in the async state machine):

- `src/codegen/async/state_code_gen.yo` — `while_loop_<n>_start:` (1532),
  `while_loop_<n>_end:` (1540, 1587 — the hoisted await-future-store path).
- `src/codegen/async/state_machine.yo` — `after_while_loop_<n>:` (2929, 3028,
  3272).

The emitted C already uses the null-statement idiom elsewhere
(plain-while lowering in `src/codegen/exprs/while_loop.yo` emits
`loop_<id>:;`), so the fix follows the existing precedent.

## Fix

Append a null statement to every emitted loop label (`label:;`). The affected
user programs are any program with an awaiting while loop, so this is a
user-visible codegen fix, not just an installer concern: on HarmonyOS every
`yo compile` invokes the strict clang.

Related, same environment: the OHOS sysroot does not define `struct statx` in
`<sys/stat.h>` (it lives in `<linux/stat.h>`); `src/codegen/async/runtime_io_linux.yo`
now includes it under `#if defined(__OHOS__)`.

## Validation

On the HarmonyOS box: patched `yo.c` (labels + statx include) compiles with
`clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2` + `pkg-config --cflags/--libs liburing`,
the built `yo` runs, and `yo compile` produces working binaries (hello world,
while loops, async programs). The regression test
`tests/async_await.test.yo::async while loops emit C11-legal labels...` pins
the shape.
