# `ctl` handlers are emitted `void` but called through value-returning casts (latent x86_64 ABI break)

**Found 2026-08-06** while root-causing
`issues/fixed/escape-path-drops-unwound-call-result-temp.md`. **Latent** — not
reachable from the current corpus, so nothing is failing today. Filed because the
mechanism is a real ABI violation and the next `ctl` with a wide `ResumeType` will hit it.

## What codegen does

`Exception.throw` is a `ctl` whose `ResumeType` is generic, and the struct field is
emitted as an untyped slot:

```c
struct __yo_struct_yo3e987b18_id_40_struct { // Exception
  void* throw;
};
```

Each **call site** casts that `void*` to whatever the surrounding expression needs. In one
`tests/internal/parser.test.yo` batch there are four distinct casts:

```
10x  ((__yo_struct_yoceebd0e9_id_35* (*)(__yo_dyn_ba9487de67))exn.throw)   // Token*
 4x  ((__yo_enum_yoe4f8607a_id_3*   (*)(__yo_dyn_ba9487de67))exn.throw)   // AstExpr*
 2x  ((__yo_struct_yodb87f9d4_id_3  (*)(__yo_dyn_ba9487de67))exn.throw)   // ParseResult
 1x  ((__yo_enum_yoceebd0e9_id_3    (*)(__yo_dyn_ba9487de67))exn.throw)   // TokenKind
```

Meanwhile every handler **specialization** is emitted returning `void`, because a handler
that unwinds never returns a value:

```c
static inline void fn_yoe90c2d94_id_19(__yo_dyn_ba9487de67 err); // ctl(..., err : AnyError) -> ResumeType
```

So the callee's real signature and the caller's cast disagree about the return type. That
is undefined behaviour in C regardless, but whether it _matters_ depends on the size:

- **≤ 16 bytes** (all four casts above — pointers, a 16-byte `ParseResult`, an enum): the
  value comes back in `RAX:RDX` / `X0:X1`. Arguments are unaffected, the returned garbage
  is the only consequence, and after the escape-path fix that garbage is never read.
- **> 16 bytes** (MEMORY class): the caller passes a **hidden sret pointer**, and on
  **x86_64 SysV that pointer consumes RDI** — so the `err` argument shifts to RSI/RDX. The
  callee, compiled as `void f(dyn err)`, reads RDI/RSI and therefore sees
  `err.data = <the sret pointer>` and `err.vtable = <err.data>`. Calling anything on `err`
  then goes through a bogus vtable.

  On **arm64 AAPCS64** the indirect result register is the dedicated **X8**, so X0/X1 still
  hold the real argument and the same code silently works. This is the same
  arm64-hides-it / x86_64-breaks-it asymmetry as the fixed bug.

## Why nothing fails today

No `ctl` in `std/` or `yo-self/` has a `ResumeType` larger than 16 bytes at a call site
that also unwinds. `ParseResult` at 16 bytes is the widest in the parser and sits exactly
at the register/memory boundary — one more field would push it over.

## CONFIRMED by measurement (2026-08-06), and it reproduces on macOS arm64

`-fsanitize=function` flags the mismatched call directly. Emitting the C for a small
`exn.throw`-in-value-position program and compiling it by hand:

```bash
./yo-cli compile src/tests/fixme.yo --emit-c --skip-c-compiler --release
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O1 \
      -fsanitize=function -fsanitize=undefined a.out.c -o /tmp/ubsan.out
/tmp/ubsan.out
```

```
a.out.c:2604:61: runtime error: call to function fn_yo6f45cce5_id_24 through pointer to
  incorrect function type 'struct __yo_struct_yo51ba7706_id_834_struct *(*)(__yo_dyn_ba9487de67)'
  note: fn_yo6f45cce5_id_24 defined here
SUMMARY: UndefinedBehaviorSanitizer: undefined-behavior a.out.c:2604:61
```

So the signature mismatch is real and **does not need a Linux or x86_64 host to detect** —
only the _consequences_ are x86_64-specific. That makes this cheap to gate: see below.

## Repro sketch for the >16-byte consequence (not yet built)

A `ctl` whose `ResumeType` is a >16-byte struct, called in value position, with a handler
that unwinds. Verify by inspecting the emitted x86_64 assembly for the call: the caller
will `lea` a stack slot into RDI and put the dyn's words in RSI/RDX, while the callee reads
RDI as `err.data`. `clang --target x86_64-... -S` is enough — no x86_64 host needed, and
Rosetta is not installed on the dev machine so the binary cannot be run locally anyway.

## Possible fixes

1. **Emit each handler specialization with its `ResumeType` return type** and return a
   zeroed value on the unwind path. The specializations already exist per `ResumeType`
   (ids 19, 28, 37, … in one batch), so the information is available.
2. **Give `throw` a uniform ABI** — always sret, or always pass the result slot
   explicitly — so no call site needs a per-site cast.

(1) is the smaller change and keeps the field's `void*` shape.

## Guard to add with the fix

`-fsanitize=function` catches this class, works on macOS arm64 (measured above), and is
**not** currently enabled for test binaries (`src/test-runner.ts` uses ASan). Turning it on
would have caught this years earlier and will catch the next occurrence.

Do NOT enable it before fixing the mismatch, though: every `exn.throw` call site in the
existing corpus trips it, so it would fail the suite wholesale. Sequence: fix the handler
signatures, then enable the check as the regression guard.
