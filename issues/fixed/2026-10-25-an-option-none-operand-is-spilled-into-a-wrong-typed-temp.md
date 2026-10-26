# An `Option(...).None` operand is spilled into a wrong-typed temp (windows-11-arm CI)

**Severity:** S2 — the spilled temp is declared with the option's PAYLOAD type instead of staying
the bare `NULL` a header parameter accepts, so a Windows cross-compile of the compiler itself fails
in clang: `incompatible pointer types passing 'uint32_t *' to a parameter of type
'LPDWORD'` (`unsigned long *`). Broke the windows-11-arm CI shards (all 4, both batteries) from
fb43ea19b (#1610, the operand-sequencing fix); the seed-based emit in that PR's battery missed it
because the SEED has no spill at all.

**Status:** fixed (codegen). Found 2026-10-25 in develop's battery after #1610.

## Reproducer

`src/lsp/transport.yo:198` (the LSP stdin readiness probe), cross-emitted with the TREE binary:

```yo
peeked := unsafe(PeekNamedPipe(h, Option(*void).None, u32(0), Option(*u32).None, addr_of(avail), Option(*u32).None));
```

`PeekNamedPipe` comes from a `c_include` (its real prototype is `... LPDWORD ...`), and the
`.None` arguments are nullable-pointer options rendered as a bare `NULL`. After #1610 the emitted C
was (CI artifact `cross/yo-windows-arm64.c`):

```c
unsigned long __yo_v_avail = ((unsigned long)(0));
void* __yo_seq_0 = NULL;
uint32_t* __yo_seq_1 = NULL;      // the payload type, not the parameter's
int ... = PeekNamedPipe(__yo_v_h, __yo_seq_0, 0U, __yo_seq_1, &__yo_v_avail..., NULL);
```

A bare `NULL` is a null pointer CONSTANT — accepted for every pointer parameter. A materialized
`uint32_t*` temp is not `unsigned long*` on Windows, and clang rejects the call. A minimal probe
(`issues/repros/2026-10-25-an-option-none-operand-is-spilled-into-a-wrong-typed-temp.yo`)
reproduces the spill on the native target too: two `uint32_t* __yo_seq_N = NULL;` declarations
feeding the call.

## Root cause

`sequence_operand` (#1610) never settled the operand: `_is_bare_literal` knows numbers and
`true`/`false`, not the spelling `NULL`; the nullable-pointer `.None` carries no compile-time
value on its `ExprInfo` (the evaluator leaves `.value` absent and narrows `ty`); and the temp
name-shape test does not match. The spill then typed the temp through
`expr_info_converted_runtime_type`, which converts an option to its PAYLOAD — `*u32` — while the
operand's actual rendering is the pointer-agnostic `NULL`. A later sibling `.None` was judged
"may write" by `_operand_may_write` (its BF_DOT recurses into the type-expression base
`Option(*u32)`, which the write analysis misreads as a runtime expression), which is why the
earlier `.None` operands spilled at all.

## Fix

`_operand_is_constant_enum_ctor` (`src/codegen/exprs/other_fn_call.yo`): a compile-time-constant
enum construction with NO runtime payload operands — a qualified fieldless-variant constant
(`Option(*u32).None`, a BF_DOT whose base is a type expression and whose field names a fieldless
variant) or a zero-argument variant constructor call whose callee resolves to the enum type — is
settled in `sequence_operand` alongside literals and own temps. Its rendering (a bare `NULL`, a
tag constant, or an all-constant initializer) reads nothing a later sibling could change, and
keeping the `NULL` inline keeps it a null pointer constant, which every parameter spelling
accepts. An enum-typed local or field READ is not a construction, and a payload-carrying `.Some(x)`
still reads `x`: neither is settled. Verified on the tree binary: the aarch64-pc-windows-msvc emit
of `src/main.yo` contains zero `uint32_t* __yo_seq` declarations and the `PeekNamedPipe` call
inlines `NULL` again; the native emit-diff against develop removes only the constant-ctor spills.
