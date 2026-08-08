# `ctl` handlers are emitted `void` but called through value-returning casts (x86_64 ABI break)

> **FIXED 2026-08-09.** Both compilers now cast a generic-`ResumeType` `ctl` call to
> the CALLEE's real return type and use the zero-init-temp protocol, so the caller and
> callee agree and no hidden sret pointer can displace `err`. TS emits handlers `void`
> and casts `void`; yo-self emits `void*` and casts `void*`.
>
> Measured after the fix: **1037/1037** `exn.throw` casts in the TS emit and
> **1036/1036** in yo-self's self-emit are now the callee's real type (before: 140
> non-void, 95 of them >16-byte MEMORY class).
>
> The two repros this doc called "not yet built" are checked in —
> `issues/repros/ctl-large-resume-type-sret.yo` (a 32-byte ResumeType thrown in value
> position, handler derefs `err.vtable`; `-fsanitize=function` flags it before the fix,
> clean after) and `issues/repros/ctl-large-resume-type-sret-abi-demo.c` (the same shape
> in freestanding C; cross-compiled to x86_64 the call site emits
> `leaq -40(%rbp), %rdi`, demonstrating the displacement).
>
> Validation: TS suite 2685/2685 · `gates_fast` failures=0 · FIXPOINT_HOLDS ·
> full-corpus sweep 188/188 GREEN.
>
> **The guard is NOT yet enabled.** `-fsanitize=function` on test binaries is the
> follow-up this doc recommends, and it should now be possible — that is deliberately
> left as its own change so any fallout is separable.

**Found 2026-08-06** while root-causing
`issues/fixed/escape-path-drops-unwound-call-result-temp.md`.

**Severity revised 2026-08-08.** This was filed as _latent_ on the premise that no
reachable `ctl` has a `ResumeType` over 16 bytes. Measurement refuted that premise: 95
`exn.throw` call sites in `yo-self`'s own stage-2 C cast to one of 7 distinct structs
that each exceed 16 bytes, and all 29 handlers bound to `.throw` are emitted `void*`.
Nothing fails today only because most handlers **discard `err`** — an accidental
invariant, not an enforced one, and at least one handler does dereference
`err.vtable`. See "MEASURED 2026-08-08" below.

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

~~No `ctl` in `std/` or `yo-self/` has a `ResumeType` larger than 16 bytes at a call site
that also unwinds. `ParseResult` at 16 bytes is the widest in the parser and sits exactly
at the register/memory boundary — one more field would push it over.~~

**REFUTED by measurement 2026-08-08 — see the next section. The premise above is false,
and it is false inside `yo-self`'s own emitted C.**

## MEASURED 2026-08-08: >16-byte ResumeTypes are everywhere in yo-self's own C

The claim above was never independently checked, and it does not hold. Method — take the
stage-2 self-emit (`fixpoint_only.sh` leaves it at `/tmp/<P>_stage2.c`) and read the
cast that every effect-record call site builds:

```bash
# every exn.throw call site, grouped by the return type it casts to
grep -oE '\(\([A-Za-z_][A-Za-z0-9_]* \(\*\)\([^)]*\)\)exn\.throw' /tmp/<P>_stage2.c \
  | sed -E 's/^\(\(([A-Za-z_][A-Za-z0-9_]*) .*/\1/' | sort | uniq -c | sort -rn

# then size them decisively, in one compile
cp /tmp/<P>_stage2.c /tmp/szcheck.c
printf '_Static_assert(sizeof(__yo_t299) <= 16, "OVER16: __yo_t299");\n' >> /tmp/szcheck.c
clang -std=c11 -fsyntax-only -w /tmp/szcheck.c 2>&1 | grep -oE 'OVER16: __yo_t[0-9]+'
```

Result: of 1064 `exn.throw` call sites, 140 cast to a non-`void` return type, and
**95 of those cast to one of 7 distinct structs larger than 16 bytes**:

| type        | sites | identity                      |
| ----------- | ----- | ----------------------------- |
| `__yo_t299` | 25    | `FuncParamsResult` (8 fields) |
| `__yo_t290` | 25    |                               |
| `__yo_t556` | 18    |                               |
| `__yo_t571` | 15    |                               |
| `__yo_t526` | 6     |                               |
| `__yo_t552` | 5     |                               |
| `__yo_t582` | 1     |                               |

A representative site — note this is `exn.throw` itself, not an ordinary fn-ptr call:

```c
__yo_t299 _file____User_temp_503617 =
  (((__yo_t299 (*)(__yo_t852))exn.throw)((__yo_t852)(_file____User_temp_503616)));
```

The remaining 45 non-void casts are `int64_t` / `int32_t` / `uint32_t` / `bool` and
small structs — all ≤ 16 bytes, all in the REGISTER class, all fine.

### What this does and does not establish

**Established:** the "no reachable >16-byte `ResumeType`" premise is false, so the
severity assessment that rested on it ("the bug is latent") needs redoing. This is
`yo-self` compiling ITSELF, on the same x86_64 CI architecture the SysV analysis applies
to.

**Also established (the follow-up check):** the handlers really are emitted with a
register-class return, not the concrete one. All 29 distinct functions bound to
`.throw` in the stage-2 C are `void*`:

```c
static inline void* fn_yo_id_306605(__yo_t852 err);
```

So at those 95 sites the caller builds a MEMORY-class call (hidden sret pointer in RDI,
`err` displaced to RSI) into a callee that reads `err` from RDI. The mismatch is real and
present, exactly as analyzed — the doc's own mechanism corrupts the callee **on entry**,
before any resume/unwind decision, so the original "at a call site that also unwinds"
qualifier never narrowed the exposure the way it was assumed to.

### The actual reason nothing fails today

Not the absence of large `ResumeType`s — it is that **most handlers discard `err`**:

```c
static inline void* fn_yo_id_306605(__yo_t852 err) {
  err;                       // <- a no-op statement; the value is never read
  __yo_effect_escaped = 1;
  { ... memcpy(__yo_unwind_value, &_unw_val, sizeof(__yo_t206)); }
  return (void*){0};
}
```

A garbage `err` is harmless if nobody reads it. **But not all handlers discard it** — this
one dereferences the dyn vtable, which is precisely the predicted crash:

```c
static inline void* fn_yo_id_820507(__yo_t852 err) {
  ...
  __yo_t0 _tmp = (err).vtable->to_string((err).data);   // <- bogus vtable if err is the sret ptr
```

So today's green suite rests on an **accidental invariant** — "the handlers that happen to
be bound at >16-byte call sites happen to be the ones that ignore their argument" — not on
any property the compiler enforces. Any `try`/`catch` that formats or inspects the error in
value position where the surrounding type exceeds 16 bytes moves a handler from the first
shape to the second.

### Narrowing the surviving question

Exactly **3 of the 29** handlers read `err` beyond the `err;` no-op —
`fn_yo_id_818463`, `fn_yo_id_818705`, `fn_yo_id_820507`. Locating where each is bound:

```c
// stage-2 C, inside `void __yo_user_main(__yo_t119 io) {`
__yo_t19 _file____User_temp_1065093 = (__yo_t19){ .throw = fn_yo_id_820507 };
__yo_t19 exn = _file____User_temp_1065093;
```

So the `err.vtable->to_string(...)` handler is the compiler's **top-level error printer**
in `__yo_user_main` — the "yo-self: error: …" path. That is the outermost handler, the
one a throw reaches whenever no nearer handler catches it, which makes the dangerous
pairing ordinary rather than exotic.

### MEASURED 2026-08-08 (round 2): the dynamic check, run

The check the section below proposes has now been run, and it answers the open
question. Method — take the stage-2 self-emit, build it with `-fsanitize=function`
(works on macOS arm64; the CAST types it reports live in the C and so transfer to
x86_64), and drive real error paths through it:

```bash
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O1 -fsanitize=function \
      /tmp/<P>_stage2.c -o /tmp/ubsan_s2
YO_MAIN_STACK_MB=4096 /tmp/ubsan_s2 compile <file-with-a-real-error>.yo \
      --emit-c --skip-c-compiler -o /tmp/x 2>&1 | grep "incorrect function type"
```

Findings across `check` and `compile` runs over several error shapes (including a
parse error, which reaches the top-level "yo-self: error:" printer):

1. **The `err`-reading handler IS reached through a mismatched call.** The parse-error
   run flags `fn_yo_id_820940` — one of the 3 handlers that dereference `err` — called
   through `struct __yo_t135_struct (*)(__yo_t852)`.
2. **But every EXECUTED by-value throw cast is ≤ 16 bytes.** `__yo_t135` is the only
   by-value struct return reached in any run, and `_Static_assert(sizeof(...) <= 16)`
   passes for it. Every other flagged `exn.throw` cast returns a POINTER (8 bytes).
   So all of them are REGISTER class: no hidden sret pointer, `err` is not displaced,
   and the garbage return value is never read because the handler unwinds.

**That reconciles the tension.** Today's green x86_64 suite is not luck about which
handler wins — the `err`-reading top-level printer really is reached — it is that the
error paths actually exercised sit at register-class sites. The 95 >16-byte sites are
present in the emitted C but were not on any exercised error path here.

**What this does NOT establish:** that no >16-byte site is reachable. The exercise
covered a handful of error shapes, not the corpus. The pairing stays one refactor
away — any handler that formats or inspects an error in a value position whose
surrounding type exceeds 16 bytes moves a live site into the dangerous shape — so
this is **still a real bug to fix, just not one that is firing today**. It is
schedulable rather than urgent, and the TS-referee expiry at P2 remains the reason
to do it before then.

**Still not proven**, and it needs a dynamic check rather than more grepping: whether a
throw at one of the 95 large-`ResumeType` sites actually reaches THIS handler rather than
a nearer one. Two facts sit in tension and should be reconciled before the ABI work is
scheduled:

- if such a throw did reach it, `err.vtable` would be the sret pointer and the
  `to_string` dispatch would read a garbage function pointer — a hard crash, not a subtle
  wrong answer;
- yet yo-self reports compile errors correctly on x86_64 CI today.

The likeliest reconciliation is that the error paths actually exercised route through
nearer handlers or through ≤16-byte sites. Confirm by building the x86_64 binary with
`-fsanitize=function` (per the section below) and running `check` over a deliberately
broken file — that flags the mismatched call at the moment it happens, without needing to
reason about which handler won.

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

## Implementation notes (2026-08-06 investigation — deferred, do as its own PR)

Scoping for fix (1) found the void convention is load-bearing across TWO
call protocols, and their inconsistency is the real bug:

- **Statically-known handler calls** (`other-fn-call.ts` `handlerReturnsVoid`
  path, ~line 3158): zero-init a typed temp BEFORE the call, call the handler
  AS VOID, check `__yo_effect_escaped`. The comment records this protocol was
  itself a fix: assigning a void call's "return value" to a typed temp is UB
  and **crashed on WASM**.
- **Field-access calls** (`exn.throw` through the effect record's `void*`
  slot): per-site cast to a value-returning fn type — the UBSan-confirmed
  mismatch this issue is about.

Changing to concrete-`ResumeType` returns must touch, coherently:
`generation.ts:1234` (specialization return-type override is skipped for
`isEffectRecordMember`), both call protocols above, the unwind dummy-return
emission (`generation.ts` escape path: "return a dummy value"), the
thread-local `__yo_unwind_value` stash, and the yo-self mirrors of all of
these — then enable `-fsanitize=function` as the guard (only after, or the
suite fails wholesale). The WASM history means validation needs the wasm32
CI arms, not just native.

Recommendation: implement as a dedicated PR after PR 76 merges — ~~the bug is
latent (no reachable `ctl` has a >16-byte `ResumeType` at an unwinding call
site), and~~ this is ABI surgery across every effects call path.

**Updated 2026-08-08:** the latency argument above is withdrawn — 95 `exn.throw` call
sites in `yo-self`'s own stage-2 C cast to >16-byte return types (see the measured
section). Before budgeting the ABI surgery, do the one remaining cheap check: confirm
whether the handlers bound at those sites are emitted `void`. If they are, this stops
being latent and should be sequenced ahead of `plans/SELF_HOSTING_COMPLETION.md` P1 —
it is exactly the class of thing that gets far more expensive to adjudicate once the
TypeScript reference compiler is retired in P2.
