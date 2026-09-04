# `asm()` ships none of the target/register validation its manual promises — wasm silently aborts at run time, MSVC and every non-x86 register emit uncompilable C

**Found**: 2026-09-04, by the std-API audit re-measurement, while checking
whether `asm("", in(reg, x))` (Rust's `black_box`) is a portable mechanism for
`std/testing/bench`. **Class**: api-lie — four separate claims in
`docs/en-US/INLINE_ASSEMBLY.md` (and their `docs/zh-CN/` mirrors, same line
numbers) describe compiler behaviour that does not exist. **Status**: OPEN.

The consequence is not cosmetic: someone designing against these promises
ships a wasm-fatal API believing the compiler would have stopped them, and
someone following the manual's own aarch64 example gets a raw C-compiler
error about generated code.

## Symptom 1 — wasm32: no compile-time error, a runtime `abort()` instead

`docs/en-US/INLINE_ASSEMBLY.md:878` (zh-CN `:878`):

> WebAssembly does not support inline assembly. `asm(...)` produces a
> compile-time error when targeting `wasm32`.

```rust
open(import("std/fmt"));
pragma(Pragma.AllowUnsafe);
main :: (fn() -> unit)({
  x := u64(7);
  y := asm("mov {0}, {1}", out(reg, u64), in(reg, x), asm_options(pure, nomem, nostack));
  println(`y=${y}`);
});
export(main);
```

```
$ yo compile r1.yo --target wasm32-wasip1 --emit-c --skip-c-compiler --optimize 2 -o r1w.out
$ echo $?
0
```

The emitted C (`r1w.out.c:1315-1319`):

```c
void __yo_user_main() {
  uint64_t x = 7ULL;
  /* Error: inline assembly is not supported on WebAssembly */
  abort();
  uint64_t y = (*((uint64_t*)NULL));
```

So the build is clean and the program dies at run time (`abort()`, and a NULL
dereference immediately after it). Expected: `yo compile` fails with a
diagnostic pointing at the `asm(...)` call in the user's source.

## Symptom 2 — MSVC targets: no compile-time error, GCC-syntax `__asm__` emitted

`docs/en-US/INLINE_ASSEMBLY.md:839` (and the summary rows at `:896` and
`:1096`):

> **Compile-time error**: `asm(...)` produces an error: `"Inline assembly is
> not supported with MSVC x64. Use compiler intrinsics or a separate .asm
> file."`

```
$ yo compile r1m.yo --target x86_64-pc-windows-msvc --emit-c --skip-c-compiler --optimize 2 -o r1m.out
$ echo $?
0
$ grep -n '__asm__' r1m.out.c
2388:  __asm__ (
```

`x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc` are real, supported
triples (`src/target.yo:67`), and the compiler happily emits GNU-C inline
assembly for them — the one syntax `cl.exe` does not accept.

## Symptom 3 — the register-availability check does not exist

`docs/en-US/INLINE_ASSEMBLY.md:895` promises
`"Register '{r}' is not available on {arch}"`. `grep -rn 'not available on' src/ --include='*.yo'`
returns nothing. On an `aarch64-apple-darwin` host:

```rust
pragma(Pragma.AllowUnsafe);
main :: (fn() -> unit)({
  y := asm("nop", out("eax", u32), asm_options(pure, nomem, nostack));
  __yo_var_print_info(y);
});
export(main);
```

```
$ yo compile r1r.yo --optimize 2 -o r1r_full.out
r1r_full.out.c:1383:15: error: invalid output constraint '=a' in asm
1 error generated.
yo: error: compile: C compiler failed (exit 1) on r1r_full.out.c
```

`eax` is x86-only and the evaluator accepts it without comment; the failure
surfaces as a C-compiler error about a generated file the user never wrote.

## Symptom 4 — the documented per-arch register tables mostly do not work

`docs/en-US/INLINE_ASSEMBLY.md:403-410` lists, as "Supported explicit register
names per architecture", `rax`..`r15`, `xmm0`..`xmm15`, `ymm0`..`ymm15`,
`flags` for x86_64 and `x0`..`x30`, `w0`..`w30`, `v0`..`v31`, `d0`..`d31`,
`s0`..`s31`, `nzcv` for aarch64. The manual's own aarch64 syscall example
(`:394-400`) does not compile:

```rust
pragma(Pragma.AllowUnsafe);
main :: (fn() -> unit)({
  asm("svc #0", in("x8", u64(64)), in("x0", u64(1)), in("x1", u64(0)), in("x2", u64(13)));
});
export(main);
```

```
$ yo compile r1b.yo --optimize 2 -o r1b.out
r1b.out.c:1383:14: error: invalid input constraint 'x8' in asm
```

emitted as:

```c
  __asm__ __volatile__ (
      "svc #0"
      : 
      : [x8] "x8" (64ULL), [x0] "x0" (1ULL), [x1] "x1" (0ULL), [x2] "x2" (13ULL)
```

`out("x0", u64)` fails the same way (`invalid output constraint '=x0'`).

## Root cause

Two gaps, one in each half of the pipeline.

**The evaluator has no target awareness at all.** `evaluate_asm`
(`src/evaluator/builtins/asm.yo:667`) validates operand *shape* and *type*
only — `_is_valid_asm_operand_type` at `:94` accepts integer/float/pointer/bool,
`_register_classes` at `:47-56` lists the seven abstract classes, and
`_is_asm_subcall_name` at `:62` the operand kinds. There is no reference to
the compilation target anywhere in the file: `grep -niE 'msvc|is_target_windows'`
over `src/evaluator/builtins/asm.yo` and `src/codegen/exprs/asm.yo` is empty,
and the only `target`-ish identifier in the evaluator file is
`target_var_name`, the *variable*-target output mode (`:89`, `:379`), which is
unrelated. The target IS reachable from the evaluator —
`src/evaluator/builtins/process.yo:29` imports `get_current_target` from
`src/target.yo:288` and calls it at `:49` — it simply is not consulted here.

**Codegen's only target check is a runtime abort, not a diagnostic.**
`generate_asm` (`src/codegen/exprs/asm.yo:514`) opens with

```rust
if(is_target_wasm(context.base.target_info), {
  … "/* Error: inline assembly is not supported on WebAssembly */" …
  … "abort();" …
  … "(*((" + type + "*)NULL))" …
});
```

(`src/codegen/exprs/asm.yo:523-533`) — symptom 1. Nothing anywhere checks the
Windows ABI (symptom 2).

**Explicit register names are passed through verbatim as GCC constraints.**
`_explicit_register_constraint` (`src/codegen/exprs/asm.yo:32-42`) maps exactly
six x86 legacy registers to constraint letters (`rax|eax|ax|al → "a"`, and
b/c/d/S/D). `_resolve_constraint` (`:66-100`) tries `raw:`, then that table,
then the abstract class table, and otherwise **returns the string unchanged**
(`:100`, bare `c`). So `x0`, `x8`, `r8`, `xmm0` and every other name in the
documented table becomes the literal GCC constraint `"x0"` / `"x8"` / … —
symptoms 3 and 4. There is no per-arch register table in the tree to check
against, which is also why the promised `"Register '{r}' is not available on
{arch}"` could not have been implemented.

## Fix

Make the compiler match the manual rather than the manual match the compiler:
the docs describe the right contract, and every symptom above is a failure
that should have been a Yo diagnostic.

1. **Target rejection in the evaluator** — in `evaluate_asm`
   (`src/evaluator/builtins/asm.yo:667`) and its `global_asm` sibling, read
   `get_current_target()` (already the pattern at
   `src/evaluator/builtins/process.yo:49`) and throw with the documented
   messages: `"Inline assembly not supported on {target}"` for
   `Arch.Wasm32`, and `"Inline assembly is not supported with MSVC x64. Use
   compiler intrinsics or a separate .asm file."` for `Abi.Msvc`. Once the
   evaluator rejects wasm, `src/codegen/exprs/asm.yo:523-533` becomes
   unreachable and should become a `codegen_fatal` rather than an emitted
   `abort()` — an internal-invariant failure, not a user-visible one.
   - *Design choice on MSVC*: key the rejection on `Abi.Msvc` (the documented
     contract), not on the C compiler actually invoked. A later decision to
     accept `clang-cl`, which does understand GNU-C `__asm__`, is an additive
     relaxation and should not hold this fix up.
2. **A real per-arch explicit-register table.** Add the table the docs already
   publish (`docs/en-US/INLINE_ASSEMBLY.md:403-410`) to the evaluator, and
   reject a name that is unknown, or known to another architecture, with
   `"Register '{r}' is not available on {arch}"`.
3. **Make the accepted names actually work.** The pass-through at
   `src/codegen/exprs/asm.yo:100` cannot be right for any register outside the
   six-letter x86 table, because GNU C has no `"x0"` constraint. The portable
   lowering is a local register variable:

   ```c
   register uint64_t __asm_in_0 asm("x0") = 1ULL;
   __asm__ __volatile__("svc #0" : : "r"(__asm_in_0) : );
   ```

   which is what GCC and Clang document for named registers, works on both
   architectures, and would let `_explicit_register_constraint`'s six-entry
   special case be retired.

If (3) is too large to land with (1)+(2), split it: PR 1 does (1)+(2) — the
compiler then refuses precisely what it cannot emit, which is the whole point
of the §11.1 table — **and** trims `docs/*/INLINE_ASSEMBLY.md:403-410` to the
registers that actually work today (`rax/eax/ax/al`, `rbx…`, `rcx…`, `rdx…`,
`rsi/esi/si`, `rdi/edi/di`) with a note that the rest is pending; PR 2 does (3)
and restores the full table. What must not happen is leaving the docs asserting
checks that are not there.

## Regression test

- `tests/asm.test.yo` — extend the existing `test("Test asm comptime errors", …)`
  (`:128-131`, which already uses `comptime_expect_error`) with the foreign-
  register case, guarded by `arch` the way `test("Test asm variable target
  output")` at `:132` already is: on `Arch.Aarch64`,
  `comptime_expect_error(asm("nop", out("eax", u32)))`; on `Arch.X86_64`,
  `comptime_expect_error(asm("nop", out("x0", u64)))`.
- `tests/cli-cases/asm-rejected-on-wasm/` (new) — modelled on
  `tests/cli-cases/await-in-later-cond-branch/`, whose `cmd` is
  `compile main.yo --emit-c --skip-c-compiler --optimize 2`, `expected_rc` is
  `1` and whose `opts` pin the diagnostic with `stdout_keep_match=`. Here:
  `cmd` = `compile main.yo --target wasm32-wasip1 --emit-c --skip-c-compiler`,
  `expected_rc` = `1`, `opts` = `stdout_keep_match=Inline assembly not supported`.
  A sibling `tests/cli-cases/asm-rejected-on-msvc/` with
  `--target x86_64-pc-windows-msvc` pins symptom 2. Both must be verified RED
  (today they exit 0) before the fix. Run `yo fmt` on each fixture before
  recording with `bash scripts/cli-diff-test.sh --record` — the CI fmt gate
  scans `tests/cli-cases` and the tree hash is baked into `expected_tree`.
- After (3): a runtime `tests/asm.test.yo` case per architecture that reads a
  value back through an explicit register (`x0` on aarch64, `rax` on x86_64),
  which is what proves the lowering, not just the rejection.

## Breaking change

Yes, and it is the intended effect: a program that today compiles `asm(...)`
for `wasm32-*` or `*-pc-windows-msvc` and dies (or fails in `cl.exe`) will
stop compiling, with a diagnostic. Symptoms 3 and 4 are not breaking — those
programs already fail, just in the C compiler with a message about generated
code. Call the wasm/MSVC rejection out in the release notes for the v0.2.x
patch that carries it.
