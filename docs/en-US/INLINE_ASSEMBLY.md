# Inline Assembly (`asm`) Design

## 1. Motivation

Yo currently has no way to emit inline assembly. Low-level operations (syscalls, SIMD, hardware intrinsics, performance-critical inner loops, CPU feature detection) must be implemented as C extern functions. This forces developers to maintain separate C source files and manually wire them through the FFI.

An `asm` builtin would let developers write architecture-specific assembly directly in Yo source, with:

- **Type-safe operands** — inputs/outputs checked against Yo's type system
- **Compile-time validation** — template and constraints verified during evaluation
- **Seamless C codegen** — emits GCC/Clang extended inline assembly
- **Zero abstraction cost** — no function call overhead, register allocation by the C compiler

### Use Cases

| Use case             | Example                                           |
| -------------------- | ------------------------------------------------- |
| **Syscalls**         | Direct `syscall` instruction (Linux)              |
| **SIMD**             | SSE/AVX/NEON intrinsics via asm                   |
| **Atomics**          | Custom atomic operations beyond std               |
| **CPU features**     | `cpuid`, `rdtsc` for feature detection and timing |
| **Crypto**           | AES-NI, SHA extensions                            |
| **Spin loops**       | `pause` (x86), `yield` (ARM) for spin-wait        |
| **Barriers**         | Memory fences, compiler barriers                  |
| **Bit manipulation** | `popcnt`, `bswap`, `clz`, `ctz`                   |

---

## 2. Syntax Overview

`asm` is a **builtin function** (not a macro), consistent with Yo's function-call-for-everything philosophy.

```
asm(template, operands..., options...)
```

- **template** — `comptime_str`: assembly template with `{name}` or `{N}` placeholders
- **operands** — `in(...)`, `out(...)`, `inout(...)`, `lateout(...)`, `inlateout(...)`: typed operand declarations
- **options** — `clobber(...)`, `clobber_abi(...)`, `asm_options(...)`: side-effect and optimization hints

### Quick Examples

```rust
// No-op — no operands, no return
asm("nop");

// Read timestamp counter — single output
tsc := asm("rdtsc",
  out("eax", u32),
  out("edx", u32)
);
// tsc : tuple(u32, u32) — destructure with: (lo, hi) := ...

// Add with clobber
result := asm(
  "add {dst}, {src}",
  inout("dst", reg, x),
  in("src", reg, y),
  clobber("cc")
);

// Compiler memory barrier — clobber only
asm("", clobber("memory"));
```

---

## 3. Template String

The template is a **`comptime_str`** (double-quoted string literal), validated at compile time.

### Placeholder Syntax

| Syntax       | Meaning                                                         |
| ------------ | --------------------------------------------------------------- |
| `{name}`     | Named operand reference                                         |
| `{N}`        | Positional operand reference (0-indexed, ordered by appearance) |
| `{name:mod}` | Named operand with register modifier                            |
| `{N:mod}`    | Positional operand with register modifier                       |
| `{{`         | Literal `{`                                                     |
| `}}`         | Literal `}`                                                     |

Named and positional operands **may be mixed**, but each operand must be referenced consistently (don't reference the same operand by both name and index).

### Register Template Modifiers

Modifiers control **which sub-register name** is emitted for a placeholder. This is critical on x86 where a single physical register has multiple names depending on width.

**x86_64 modifiers:**

| Modifier | Width      | Example (if allocated to RAX) |
| -------- | ---------- | ----------------------------- |
| (none)   | 64-bit     | `rax`                         |
| `:e`     | 32-bit     | `eax`                         |
| `:x`     | 16-bit     | `ax`                          |
| `:l`     | 8-bit low  | `al`                          |
| `:h`     | 8-bit high | `ah` (only for a/b/c/d)       |

**aarch64 modifiers:**

| Modifier | Width  | Example (if allocated to X0) |
| -------- | ------ | ---------------------------- |
| (none)   | 64-bit | `x0`                         |
| `:w`     | 32-bit | `w0`                         |

**Example:**

```rust
result := asm(
  "movzx {out}, {in:l}",    // Use 8-bit low name of {in}
  out("out", reg, u32),
  in("in", reg, byte_val)
);
```

**C codegen:** Modifiers map to GCC template modifier characters:

- `{name:l}` → `%b[name]` (GCC 8-bit low)
- `{name:e}` → `%k[name]` (GCC 32-bit)
- etc.

### Template String Rules

1. Template must be a `comptime_str` literal — no runtime strings.
2. All placeholders must reference declared operands.
3. Unused operands are allowed (the C compiler may optimize them).
4. Multi-line templates are supported (Yo double-quoted strings can contain `\n`).

### Multi-instruction Templates

Use `\n` or `;` to separate instructions within a single template:

```rust
asm("push {val}\npop {out}",
  in("val", reg, x),
  out("out", reg, u64)
);
```

---

## 4. Operand Types

Operands declare the **direction** (read/write), **constraint** (where the value lives), and **type/value** of each assembly operand.

### 4.1. `in` — Input Operand

Passes a Yo value **into** the assembly as a read-only operand.

```
in(name?, constraint, value)
```

| Parameter    | Type                                | Description                           |
| ------------ | ----------------------------------- | ------------------------------------- |
| `name`       | `comptime_str` (optional)        | Operand name for `{name}` in template |
| `constraint` | register class or `comptime_str` | Where to place the value              |
| `value`      | expression                          | Yo expression providing the input     |

```rust
// Named input
asm("int {vec}", in("vec", imm, u8(0x80)));

// Positional input
asm("int {0}", in(imm, u8(0x80)));

// Specific register
asm("syscall", in("rax", u64(60)), in("rdi", u64(0)));
```

### 4.2. `out` — Output Operand

Declares an assembly output that **writes** to a register/memory, producing a Yo value.

```
out(name?, constraint, Type)
```

| Parameter    | Type                                | Description                           |
| ------------ | ----------------------------------- | ------------------------------------- |
| `name`       | `comptime_str` (optional)        | Operand name for `{name}` in template |
| `constraint` | register class or `comptime_str` | Where the result lives                |
| `Type`       | type                                | Yo type of the output value           |

The `Type` is a Yo type (not a value) — `asm` returns this type.

```rust
// Single output
count := asm("popcnt {out}, {in}",
  out("out", reg, u64),
  in("in", reg, value)
);
// count : u64

// Specific register output
result := asm("rdtsc",
  out("eax", u32),
  out("edx", u32)
);
// result : tuple(u32, u32)
```

### 4.3. `inout` — Input/Output Operand

The operand is **read then written**. The assembly uses the input value and overwrites it with a new value.

```
inout(name?, constraint, value)
```

The output type is inferred from the input expression's type.

```rust
x : i32 = 42;
result := asm("add {val}, {addend}",
  inout("val", reg, x),
  in("addend", reg, i32(10))
);
// result : i32 (same type as x)
```

### 4.4. `lateout` — Late Output Operand

Like `out`, but the compiler may **reuse** the output register for an input operand. Use when the output is written **after** all inputs are consumed.

```
lateout(name?, constraint, Type)
```

```rust
result := asm("compute {out}, {a}, {b}",
  lateout("out", reg, u64),
  in("a", reg, x),
  in("b", reg, y)
);
```

### 4.5. `inlateout` — Input + Late Output Operand

Combination of `in` and `lateout`. Input is consumed early, output is produced late.

```
inlateout(name?, constraint, value)
```

### 4.6. `const_val` — Compile-Time Constant Operand

Substitutes a **compile-time constant** directly into the assembly template text. The value is inlined as a literal — no register is allocated.

```
const_val(name?, value)
```

| Parameter | Type                         | Description                                       |
| --------- | ---------------------------- | ------------------------------------------------- |
| `name`    | `comptime_str` (optional) | Operand name for `{name}` in template             |
| `value`   | comptime expression          | Must evaluate to a compile-time integer or string |

```rust
// Inline a syscall number as an immediate
asm("mov rax, {num}\nsyscall",
  const_val("num", u64(60)),
  in("rdi", u64(0)),
  clobber("rcx", "r11", "memory")
);

// Inline a computed constant
BUFFER_SIZE :: 4096;
asm("sub rsp, {size}",
  const_val("size", BUFFER_SIZE)
);
```

**C codegen:** The constant is rendered as a literal in the template string itself — it does not appear in the GCC operand lists:

```c
// const_val("num", 60) → template substitution
__asm__ __volatile__ ("mov rax, $60\nsyscall" : : "D" (0) : "rcx", "r11", "memory");
```

> **Note:** Named `const` is a Yo keyword, so the operand is called `const_val` to avoid ambiguity.

### 4.7. `sym` — Symbol Operand

References the **address of a symbol** (extern function or global variable) in the assembly template. No register is allocated — the linker resolves the symbol.

```
sym(name?, symbol)
```

| Parameter | Type                         | Description                           |
| --------- | ---------------------------- | ------------------------------------- |
| `name`    | `comptime_str` (optional) | Operand name for `{name}` in template |
| `symbol`  | extern function or global    | The symbol whose address to reference |

```rust
extern "C",
  memcpy : (fn(dest: *(u8), src: *(u8), n: usize) -> *(u8));

// Call an extern function from inline asm
asm("call {func}",
  sym("func", memcpy),
  in("rdi", dest),
  in("rsi", src),
  in("rdx", len),
  clobber_abi("C")
);
```

**C codegen:** Uses GCC's symbolic operand:

```c
__asm__ __volatile__ ("call %[func]" :: [func] "i" (memcpy), ... : /* clobbers */);
```

### 4.8. Discarded Output (`_`)

Use `_` as the output target to **clobber a specific register** without binding the result. This is essential when an instruction writes to a register you don't need:

```rust
// CPUID: we only need eax and ecx, discard ebx and edx
(out_eax, out_ecx) := asm("cpuid",
  inout("eax", leaf),
  out("ebx", _),          // clobbered, value discarded
  inout("ecx", subleaf),
  out("edx", _)           // clobbered, value discarded
);
```

Discarded outputs do **not** contribute to the return type. They only inform the C compiler that the register is modified.

**C codegen:**

```c
int32_t __asm_inout_0 = leaf;
int32_t __asm_inout_1 = subleaf;
int32_t __asm_discard_0;  // temporary, never read
int32_t __asm_discard_1;
__asm__ __volatile__ (
    "cpuid"
    : [eax] "+a" (__asm_inout_0), [ebx] "=b" (__asm_discard_0),
      [ecx] "+c" (__asm_inout_1), [edx] "=d" (__asm_discard_1)
    :
    :
);
```

### Operand Summary Table

| Operand     | Direction         | Input | Output | GCC Constraint Prefix | Notes                       |
| ----------- | ----------------- | ----- | ------ | --------------------- | --------------------------- |
| `in`        | Read              | ✅    | ❌     | (none)                |                             |
| `out`       | Write             | ❌    | ✅     | `=`                   | `out(_, _)` = discard       |
| `inout`     | Read+Write        | ✅    | ✅     | `+`                   |                             |
| `lateout`   | Late Write        | ❌    | ✅     | `=&`                  |                             |
| `inlateout` | Read + Late Write | ✅    | ✅     | `+&`                  |                             |
| `const_val` | Compile-time      | ✅    | ❌     | (inlined in template) | Value substituted literally |
| `sym`       | Symbol address    | ✅    | ❌     | `"i"` (symbol)        | Linker-resolved             |

---

## 5. Register Constraints

Register constraints tell the C compiler **where** to place each operand.

### 5.1. Abstract Register Classes

These are architecture-independent names that Yo maps to the correct GCC constraint:

| Yo Constraint | GCC (x86_64) | GCC (aarch64) | Description                               |
| ------------- | ------------ | ------------- | ----------------------------------------- |
| `reg`         | `"r"`        | `"r"`         | Any general-purpose register              |
| `reg_byte`    | `"q"`        | —             | 8-bit capable register (x86: al/bl/cl/dl) |
| `reg_abcd`    | `"Q"`        | —             | eax/ebx/ecx/edx only (x86)                |
| `xmm_reg`     | `"x"`        | `"w"`         | 128-bit SIMD register                     |
| `ymm_reg`     | `"x"`        | —             | 256-bit SIMD register (AVX)               |
| `imm`         | `"i"`        | `"i"`         | Immediate integer constant                |
| `mem`         | `"m"`        | `"m"`         | Memory operand                            |
| `const`       | `"n"`        | `"n"`         | Compile-time numeric constant             |

### 5.2. Explicit Register Names

Use a specific register by passing its name as a `comptime_str`:

```rust
// x86_64 specific registers
asm("syscall",
  in("rax", u64(1)),     // syscall number
  in("rdi", u64(1)),     // fd = stdout
  in("rsi", buf_ptr),    // buffer
  in("rdx", u64(13))     // length
);

// aarch64 specific registers
asm("svc #0",
  in("x8", u64(64)),    // syscall number (write)
  in("x0", u64(1)),     // fd
  in("x1", buf_ptr),    // buffer
  in("x2", u64(13))     // length
);
```

Supported explicit register names per architecture:

| Architecture | General Purpose                                         | SIMD                                  | Special |
| ------------ | ------------------------------------------------------- | ------------------------------------- | ------- |
| **x86_64**   | `rax`..`r15`, `eax`..`r15d`, `ax`..`r15w`, `al`..`r15b` | `xmm0`..`xmm15`, `ymm0`..`ymm15`      | `flags` |
| **aarch64**  | `x0`..`x30`, `w0`..`w30`                                | `v0`..`v31`, `d0`..`d31`, `s0`..`s31` | `nzcv`  |
| **x86**      | `eax`, `ebx`, `ecx`, `edx`, `esi`, `edi`, `ebp`, `esp`  | `xmm0`..`xmm7`                        | `flags` |
| **arm**      | `r0`..`r15`                                             | `d0`..`d31`, `s0`..`s31`              | `cpsr`  |

### 5.3. Raw GCC Constraint Strings

For advanced use, pass a raw GCC constraint string (prefixed with `=` or `+` automatically for outputs):

```rust
asm("divq {divisor}",
  inout(raw("a"), lo),       // rax: quotient + low input
  lateout(raw("d"), u64),    // rdx: remainder
  in("divisor", reg, divisor),
  clobber("cc")
);
```

The `raw(constraint_string)` wrapper passes the string directly to GCC without transformation.

---

## 6. Clobbers and Options

### 6.1. `clobber` — Register/Memory Clobbers

Declares that the assembly **modifies** a register or memory without it being an explicit operand.

```
clobber(register_or_special...)
```

Special clobber values:

| Value      | Meaning                                                |
| ---------- | ------------------------------------------------------ |
| `"memory"` | Assembly reads/writes memory not specified in operands |
| `"cc"`     | Assembly modifies the condition/status flags           |

```rust
asm("lock; xadd {old}, ({ptr})",
  out("old", reg, i32),
  in("ptr", reg, &counter),
  clobber("memory", "cc")
);
```

Multiple clobbers can be passed as separate arguments or in a single call:

```rust
clobber("memory", "cc")       // multiple in one call
clobber("memory"), clobber("cc")  // separate calls — equivalent
```

### 6.2. `clobber_abi` — ABI Register Clobbers

Clobbers **all registers** that the given calling convention does not guarantee to preserve.

```
clobber_abi("C")
```

This is equivalent to listing all caller-saved registers for the platform's C ABI.

| ABI   | x86_64 Clobbers                                    | aarch64 Clobbers          |
| ----- | -------------------------------------------------- | ------------------------- |
| `"C"` | rax, rcx, rdx, rsi, rdi, r8-r11, xmm0-xmm15, flags | x0-x18, x30, v0-v31, nzcv |

### 6.3. `asm_options` — Assembly Block Options

Fine-grained control over the assembly block behavior:

```
asm_options(option1, option2, ...)
```

| Option            | Meaning                                    | GCC Equivalent                  |
| ----------------- | ------------------------------------------ | ------------------------------- |
| `pure`            | No side effects except outputs             | removes `volatile`              |
| `nomem`           | Does not access memory                     | adds `"memory"` NOT needed      |
| `readonly`        | Only reads (never writes) memory           | informational                   |
| `nostack`         | Does not use or modify the stack           | informational                   |
| `preserves_flags` | Does not modify status flags               | omit `"cc"` clobber             |
| `att_syntax`      | Template uses AT&T syntax (default on GCC) | —                               |
| `intel_syntax`    | Template uses Intel syntax                 | `.intel_syntax noprefix` prefix |
| `volatile`        | Always emit, never optimize away (default) | `__volatile__`                  |
| `noreturn`        | Assembly block never returns               | marks code after as unreachable |

```rust
// Pure computation — optimizer can move/eliminate
tsc := asm("rdtsc",
  out("eax", u32),
  out("edx", u32),
  asm_options(pure, nomem, nostack)
);
```

**By default, `asm` is `volatile`** — the assembly is always emitted and never reordered or eliminated. Add `pure` to allow the optimizer to treat it as a computation.

### 6.4. `noreturn` — Non-Returning Assembly

When `noreturn` is specified, the assembly block **never returns** to the following code. The compiler treats subsequent code as unreachable. No output operands are allowed with `noreturn`.

```rust
// Custom halt/trap
asm("ud2", asm_options(noreturn));

// Kernel entry point — jumps and never comes back
asm("jmp {entry}",
  sym("entry", kernel_main),
  asm_options(noreturn)
);
```

**C codegen:**

```c
__asm__ __volatile__ ("ud2" :::);
__builtin_unreachable();  // tell optimizer this point is unreachable
```

The return type of an `asm` with `noreturn` is `noreturn` (Yo's bottom type), similar to `panic`.

### 6.5. Multi-String Templates

For readability, multiple `comptime_str` arguments at the start of `asm` are **joined with `\n`**. This avoids manual `\n` in long templates:

```rust
// Multiple strings — each becomes one instruction line
asm(
  "push {val}",
  "shl {val}, 2",
  "pop {out}",
  in("val", reg, x),
  out("out", reg, u64)
);

// Equivalent single-string form:
asm("push {val}\nshl {val}, 2\npop {out}",
  in("val", reg, x),
  out("out", reg, u64)
);
```

The parser collects consecutive `comptime_str` arguments until it encounters a non-string argument (operand or option).

---

## 7. Output Modes

`asm` supports two output modes: **return-value outputs** and **variable-target outputs**. They can be mixed in a single `asm` call.

### 7.1. Return-Value Outputs (Type Argument)

When the last argument to `out` / `lateout` is a **type**, the output becomes part of the `asm` return value:

```rust
// Single return-value output
result := asm("rdtsc", out("eax", u32));
// result : u32

// Multiple return-value outputs → tuple
(lo, hi) := asm("rdtsc",
  out("eax", u32),   // tuple field 0
  out("edx", u32)    // tuple field 1
);
// (lo, hi) : tuple(u32, u32)
```

**Return type inference:**

| Return-Value Outputs | Return Type          |
| -------------------- | -------------------- |
| None                 | `unit`               |
| One `out(_, T)`      | `T`                  |
| One `inout(_, v)`    | `typeof(v)`          |
| Multiple             | `tuple(T1, T2, ...)` |

`inout` and `inlateout` always count as return-value outputs.

### 7.2. Variable-Target Outputs (Variable Argument)

When the last argument to `out` / `lateout` is a **variable**, the assembly writes directly to that variable. This is essential for initializing uninitialized variables:

```rust
// Declare uninitialized variables
(lo : u32);
(hi : u32);

// asm writes to them — marks them as initialized
asm("rdtsc",
  out("eax", lo),    // writes to lo
  out("edx", hi)     // writes to hi
);

// lo and hi are now initialized and usable
total := ((u64(hi) << u64(32)) | u64(lo));
```

**How the evaluator distinguishes the two modes:**

- If the operand argument evaluates to a **type** (e.g., `u32`, `i64`, `*(u8)`) → return-value output
- If the operand argument evaluates to a **variable reference** (e.g., `lo`, `my_var`) → variable-target output

Since Yo does not allow variable shadowing, there is no ambiguity between type names and variable names.

**Initialization tracking:**

The evaluator marks variable-target outputs as **initialized** after the `asm` expression. Before the `asm`, using the variable is a compile-time error:

```rust
(x : i32);
// print(x);  // ERROR: variable 'x' is not initialized

asm("mov {0}, $42", out(reg, x));

print(x);  // OK: x is now initialized by asm
```

**Variable-target outputs do NOT contribute to the return type.** Only return-value outputs and `inout` operands determine the return type.

### 7.3. Mixed Mode Example

Variable-target and return-value outputs can coexist:

```rust
(remainder : u64);

quotient := asm("divq {divisor}",
  inout("eax", lo),               // return-value (inout always returns)
  out("edx", remainder),          // variable-target (writes to remainder)
  in("divisor", reg, divisor),
  clobber("cc")
);
// quotient : u64 (from inout)
// remainder is now initialized
```

### 7.4. C Codegen for Variable-Target Outputs

**Yo source:**

```rust
(lo : u32);
(hi : u32);
asm("rdtsc", out("eax", lo), out("edx", hi));
```

**Generated C:**

```c
uint32_t lo;  // uninitialized — from (lo : u32)
uint32_t hi;
__asm__ __volatile__ (
    "rdtsc"
    : [eax] "=a" (lo), [edx] "=d" (hi)
    :
    :
);
// lo and hi are now assigned by the asm block
```

This is more efficient than the return-value approach because no temporary variables are needed — the C compiler directly assigns to the target variables.

---

## 8. C Code Generation

### 8.1. Mapping to GCC Extended Assembly

`asm(...)` compiles to GCC extended inline assembly:

```c
__asm__ __volatile__ (
    "template"
    : /* outputs */  [name] "constraint" (var), ...
    : /* inputs */   [name] "constraint" (expr), ...
    : /* clobbers */ "reg", "memory", ...
);
```

### 8.2. Template Transformation

Yo template placeholders are transformed to GCC operand references:

| Yo Template | GCC Template |
| ----------- | ------------ |
| `{name}`    | `%[name]`    |
| `{0}`       | `%0`         |
| `{{`        | `{`          |
| `}}`        | `}`          |

### 8.3. Full Example — Yo to C

**Yo source:**

```rust
(lo, hi) := asm("rdtsc",
  out("lo", "eax", u32),
  out("hi", "edx", u32)
);
```

**Generated C:**

```c
uint32_t __asm_out_0;
uint32_t __asm_out_1;
__asm__ __volatile__ (
    "rdtsc"
    : [lo] "=a" (__asm_out_0), [hi] "=d" (__asm_out_1)
    :
    :
);
// __asm_out_0 and __asm_out_1 are used where lo/hi are referenced
```

### 8.4. `inout` Codegen

**Yo source:**

```rust
result := asm("add {val}, {addend}",
  inout("val", reg, x),
  in("addend", reg, y),
  clobber("cc")
);
```

**Generated C:**

```c
int32_t __asm_inout_0 = x;
__asm__ __volatile__ (
    "add %[val], %[addend]"
    : [val] "+r" (__asm_inout_0)
    : [addend] "r" (y)
    : "cc"
);
// result = __asm_inout_0
```

### 8.5. Unit Return (No Outputs)

**Yo source:**

```rust
asm("mfence", clobber("memory"));
```

**Generated C:**

```c
__asm__ __volatile__ ("mfence" ::: "memory");
```

### 8.6. Intel Syntax

**Yo source:**

```rust
result := asm("mov {out}, {in}",
  out("out", reg, u64),
  in("in", reg, value),
  asm_options(intel_syntax)
);
```

**Generated C:**

```c
uint64_t __asm_out_0;
__asm__ __volatile__ (
    ".intel_syntax noprefix\n"
    "mov %[out], %[in]\n"
    ".att_syntax prefix"
    : [out] "=r" (__asm_out_0)
    : [in] "r" (value)
    :
);
```

---

## 9. `global_asm` — Module-Level Assembly

For assembly that lives **outside** any function (data sections, function prologues, linker directives), use `global_asm`:

```rust
global_asm(".section .note.GNU-stack,\"\",@progbits");

global_asm(
  ".global my_asm_func\n"
  "my_asm_func:\n"
  "  ret"
);
```

### Syntax

```
global_asm(template)
```

- `template` — `comptime_str`: raw assembly emitted at file scope
- No operands, no return value
- Must appear at module top level (not inside a function)

### C Codegen

```c
__asm__ (".section .note.GNU-stack,\"\",@progbits");
```

---

## 10. Platform & Compiler Considerations

### 10.1. Compiler Support Matrix

| Compiler       | Inline ASM    | `global_asm` | Notes                     |
| -------------- | ------------- | ------------ | ------------------------- |
| **GCC**        | ✅ `__asm__`  | ✅ `__asm__` | Full support              |
| **Clang**      | ✅ `__asm__`  | ✅ `__asm__` | GCC-compatible            |
| **Zig cc**     | ✅ `__asm__`  | ✅ `__asm__` | Clang backend             |
| **MSVC (x64)** | ❌            | ❌           | No inline asm for x64     |
| **MSVC (x86)** | ⚠️ `__asm {}` | ❌           | Different syntax, limited |

### 10.2. MSVC Strategy

MSVC x64 does **not** support inline assembly. When targeting MSVC:

1. **Compile-time error**: `asm(...)` produces an error: `"Inline assembly is not supported with MSVC x64. Use compiler intrinsics or a separate .asm file."`
2. **Intrinsics alternative**: Provide `std/arch` module with compiler-intrinsic wrappers (future work).
3. **External ASM**: Users can write `.asm` files and link them via the build system.

For MSVC x86, the `__asm {}` syntax is different enough that we do not attempt automatic translation. Same compile-time error applies.

### 10.3. Architecture Gating

Use Yo's compile-time platform/arch detection to gate architecture-specific assembly:

```rust
platform :: __yo_process_platform();
arch :: __yo_process_arch();

rdtsc :: (fn() -> u64)(
  cond(
    (arch == Arch.X86_64) => {
      (lo, hi) := asm("rdtsc",
        out("eax", u32),
        out("edx", u32),
        asm_options(pure, nomem, nostack)
      );
      (u64(hi) << u64(32)) | u64(lo);
    },
    (arch == Arch.Aarch64) => {
      asm("mrs {0}, cntvct_el0",
        out(reg, u64),
        asm_options(pure, nomem, nostack)
      );
    },
    true => comptime_assert(false, "rdtsc: unsupported architecture")
  )
);
```

Dead code elimination ensures only the target architecture's assembly is emitted in the C output.

### 10.4. WebAssembly

WebAssembly does not support inline assembly. `asm(...)` produces a compile-time error when targeting `wasm32`.

---

## 11. Safety & Validation

### 11.1. Compile-Time Validation (Evaluator)

The evaluator performs these checks:

| Check                                                   | Error                                                  |
| ------------------------------------------------------- | ------------------------------------------------------ |
| Template is `comptime_str`                           | `"asm template must be a compile-time string literal"` |
| Constraint is `comptime_str` or valid register class | `"Invalid register constraint: {c}"`                   |
| Output type is a concrete primitive/pointer type        | `"asm output type must be a concrete type (got {T})"`  |
| All template placeholders reference existing operands   | `"asm template references undefined operand '{name}'"` |
| No duplicate operand names                              | `"Duplicate asm operand name: '{name}'"`               |
| Architecture-specific registers match target            | `"Register '{r}' is not available on {arch}"`          |
| Target is not MSVC x64 or wasm32                        | `"Inline assembly not supported on {target}"`          |

### 11.2. Allowed Types

Only these Yo types may be used as `asm` operands:

| Category     | Types                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| **Integers** | `i8`, `i16`, `i32`, `i64`, `u8`, `u16`, `u32`, `u64`, `usize`, `isize` |
| **Floats**   | `f32`, `f64`                                                           |
| **Pointers** | `*(T)` for any `T`                                                     |
| **Bool**     | `bool` (treated as `i8` in asm context)                                |

Reference-counted types (`ref(struct(...))`, `String`, etc.) are **not allowed** — asm operates on raw values only.

### 11.3. CTFE Blocking

`asm(...)` **blocks compile-time function evaluation**. A function containing `asm` cannot be evaluated at compile time (similar to `panic`). This is enforced in the CTFE analysis pass.

### 11.4. No Safety Wrapper

Yo does not have `unsafe` blocks. Inline assembly is inherently unsafe — it can corrupt the stack, violate aliasing rules, and cause undefined behavior. This matches Yo's philosophy of trusting the developer for low-level operations (similar to raw pointer usage, which is also unchecked).

The compile-time validation catches structural errors (bad template, wrong types, unknown registers) but cannot verify the assembly itself is correct.

---

## 12. Comprehensive Examples

### 12.1. x86_64 Syscall (Linux write)

```rust
sys_write :: (fn(fd: u64, buf: *(u8), len: u64) -> i64)(
  asm("syscall",
    in("rax", u64(1)),     // SYS_write
    in("rdi", fd),
    in("rsi", buf),
    in("rdx", len),
    out("rax", i64),       // return value
    clobber("rcx", "r11", "memory")
  )
);
```

### 12.2. Atomic Compare-and-Swap (x86_64)

```rust
cas :: (fn(ptr: *(i32), expected: i32, desired: i32) -> tuple(i32, bool))(
  {
    prev := asm(
      "lock cmpxchg {ptr_mem}, {desired}",
      inout("eax", expected),
      in("desired", reg, desired),
      in("ptr_mem", mem, ptr),
      clobber("cc", "memory")
    );
    (old, success) := (prev, (prev == expected));
    (old, success);
  }
);
```

### 12.3. ARM64 Memory Barrier

```rust
dmb_ish :: (fn() -> unit)(
  asm("dmb ish", clobber("memory"))
);
```

### 12.4. CPUID (x86_64)

```rust
CpuidResult :: struct(eax: u32, ebx: u32, ecx: u32, edx: u32);

cpuid :: (fn(leaf: u32, subleaf: u32) -> CpuidResult)(
  {
    (out_eax, out_ebx, out_ecx, out_edx) := asm("cpuid",
      inout("eax", leaf),
      out("ebx", u32),
      inout("ecx", subleaf),
      out("edx", u32)
    );
    CpuidResult(out_eax, out_ebx, out_ecx, out_edx);
  }
);
```

### 12.5. Spin-Wait Hint

```rust
spin_hint :: (fn() -> unit)(
  cond(
    (arch == Arch.X86_64) => asm("pause"),
    (arch == Arch.Aarch64) => asm("yield"),
    true => ()  // no-op on other architectures
  )
);
```

### 12.6. Read Performance Counter (Cross-Platform)

```rust
perf_counter :: (fn() -> u64)(
  cond(
    (arch == Arch.X86_64) => {
      (lo, hi) := asm("rdtsc",
        out("eax", u32),
        out("edx", u32),
        asm_options(pure, nomem, nostack)
      );
      ((u64(hi) << u64(32)) | u64(lo));
    },
    (arch == Arch.Aarch64) =>
      asm("mrs {0}, cntvct_el0",
        out(reg, u64),
        asm_options(pure, nomem, nostack)
      ),
    true => u64(0)
  )
);
```

### 12.7. Byte Swap

```rust
bswap32 :: (fn(value: u32) -> u32)(
  cond(
    (arch == Arch.X86_64) =>
      asm("bswap {0}",
        inout(reg, value),
        asm_options(pure, nomem, nostack)
      ),
    (arch == Arch.Aarch64) =>
      asm("rev {0}, {1}",
        out(reg, u32),
        in(reg, value),
        asm_options(pure, nomem, nostack)
      ),
    true => {
      // Fallback: manual byte swap
      (((value >> u32(24)) & u32(0xFF)) |
       (((value >> u32(16)) & u32(0xFF)) << u32(8)) |
       (((value >> u32(8)) & u32(0xFF)) << u32(16)) |
       ((value & u32(0xFF)) << u32(24)));
    }
  )
);
```

---

## 13. Future Work

### 13.1. `std/arch` Module

A standard library module providing portable wrappers for common intrinsics:

```rust
// std/arch/x86_64.yo
open import "std/arch/x86_64";

result := _mm_add_ps(a, b);  // SSE add
tsc := rdtsc();               // wraps asm("rdtsc", ...)
```

### 13.2. MSVC Intrinsic Mapping

Map common `asm` patterns to MSVC `__intrin.h` intrinsics automatically:

```rust
// On GCC/Clang: emits inline asm
// On MSVC: emits __rdtsc() intrinsic call
tsc := rdtsc();
```

### 13.3. Named Assembly Functions

Allow defining entire functions in assembly (beyond `global_asm`):

```rust
// Potential future syntax
naked_fn :: asm_fn(fn(a: u64, b: u64) -> u64,
  "add rax, rdi, rsi\n"
  "ret"
);
```

---

## 14. Design Decisions Summary

| Decision                       | Choice                      | Rationale                                                                                  |
| ------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------ |
| Builtin function, not macro    | `asm(...)`                  | Builtins are Yo's primary extension mechanism; macros are a gated, prelude-level sugar layer |
| Named operands via string      | `in("name", ...)`           | Works with existing parser; no new syntax needed                                           |
| Output via return type         | `x := asm(...)`             | Functional style, no mutable output parameters                                             |
| Variable-target outputs        | `out(reg, var)`             | Supports uninitialized variables; initialization tracking                                  |
| Volatile by default            | Explicit `pure` opt-in      | Most asm has side effects; safe default                                                    |
| No `unsafe` wrapper            | Bare `asm(...)`             | Yo has no unsafe concept; trusts developer                                                 |
| MSVC: compile-time error       | Not transpiled              | MSVC x64 has no inline asm; intrinsics are a separate feature                              |
| GCC `__asm__` not `asm`        | Portable C keyword          | `__asm__` works in all C standard modes (C11 strict)                                       |
| Abstract register classes      | `reg`, `imm`, `mem`         | Portable across architectures; raw fallback for advanced use                               |
| `const_val` not `const`        | Avoids keyword clash        | `const` is a Yo keyword; `const_val` is unambiguous                                        |
| Operand sub-calls not builtins | `out`, `in`, etc. are atoms | Recognized by name inside the `asm()` evaluator only; doesn't pollute the global namespace |
| `const_val` bare substitution  | No `$` or `#` prefix added  | User provides the correct syntax prefix in the template for their target architecture      |
| Clobber bare atoms             | `memory`, `cc` as atoms     | Recognized directly without evaluation for ergonomics                                      |

---

## 15. Rust `asm!` Feature Parity

Comprehensive comparison with Rust's inline assembly:

| Rust Feature                   | Yo Equivalent                                   | Status                                    |
| ------------------------------ | ----------------------------------------------- | ----------------------------------------- |
| `asm!("template", ...)`        | `asm("template", ...)`                          | ✅ Supported                              |
| `in(reg) expr`                 | `in(reg, expr)` or `in("name", reg, expr)`      | ✅ Supported                              |
| `out(reg) var`                 | `out(reg, var)` (variable-target)               | ✅ Supported                              |
| `out(reg) Type`                | `out(reg, Type)` (return-value)                 | ✅ Supported                              |
| `inout(reg) var`               | `inout(reg, expr)` / `inout("name", reg, expr)` | ✅ Supported                              |
| `lateout(reg) var`             | `lateout(...)`                                  | ✅ Supported                              |
| `inlateout(reg) var`           | `inlateout(...)`                                | ✅ Supported                              |
| `out(reg) _` (discard)         | `out(reg, _)`                                   | ✅ Supported                              |
| `const expr`                   | `const_val(expr)` / `const_val("name", expr)`   | ✅ Supported                              |
| `sym path`                     | `sym(symbol)` / `sym("name", symbol)`           | ✅ Supported                              |
| Named operands `x = in(reg) v` | `in("x", reg, v)`                               | ✅ Different syntax, same capability      |
| Positional `{0}`, `{1}`        | `{0}`, `{1}`                                    | ✅ Supported                              |
| Register modifiers `{x:e}`     | `{x:e}`                                         | ✅ Supported                              |
| `options(pure)`                | `asm_options(pure)`                             | ✅ Supported                              |
| `options(nomem)`               | `asm_options(nomem)`                            | ✅ Supported                              |
| `options(readonly)`            | `asm_options(readonly)`                         | ✅ Supported                              |
| `options(nostack)`             | `asm_options(nostack)`                          | ✅ Supported                              |
| `options(preserves_flags)`     | `asm_options(preserves_flags)`                  | ✅ Supported                              |
| `options(att_syntax)`          | `asm_options(att_syntax)`                       | ✅ Supported                              |
| `options(noreturn)`            | `asm_options(noreturn)`                         | ✅ Supported                              |
| `clobber_abi("C")`             | `clobber_abi("C")`                              | ✅ Supported                              |
| Multi-string template          | Multiple string args auto-joined                | ✅ Supported                              |
| `global_asm!`                  | `global_asm(...)`                               | ✅ Supported                              |
| `unsafe { asm!(...) }`         | `asm(...)` (no unsafe in Yo)                    | ✅ Different philosophy                   |
| `naked_asm!`                   | —                                               | 🔮 Future work (§13.3)                    |
| `label` operand                | —                                               | 🔮 Future work (experimental in Rust too) |

**Full parity** with stable Rust `asm!`. The two deferred features (`naked_asm`, `label`) are either niche or still experimental in Rust.
