# The "failed to transpile" `__attribute__((error))` guard is silently inert at `--optimize 1` and above

**Status: OPEN.** **Class**: crash — the one mechanism that turns a swallowed
definition-time evaluation into a build failure does nothing in optimized
builds, so those builds ship a binary that `abort()`s with no diagnostic.

**Found**: 2026-09-04, while measuring the `net` row of the std API audit — a
`derive(Eq)` over an `Array(u16, 8)` field built clean at `--optimize 2` and
died rc=134, and building the identical source at `--optimize 0` failed with
the intended error.

## Symptom

Any program whose body fails definition-time evaluation and is swallowed —
`issues/derive-eq-clone-ord-over-a-fixed-size-array-field-aborts-at-runtime.md`
is a four-line example — reaches codegen as an untranspilable function. Codegen
rewrites it to an `abort()` stub and declares it with a GNU `error` attribute
(`src/codegen/functions/generation.yo:826`), whose comment states the design:

> The error attribute makes the C COMPILER the deadness oracle: the build fails
> IFF a call to the stub survives — a dead generic original (no callers)
> compiles clean, while a LIVE stub … becomes a compile error at every call
> instead of an rc=134 abort with no diagnostic.

That premise holds at `-O0` only. Same source, same compiler, two optimization
levels:

```
$ yo compile derive_eq_array.yo --std-path ./std --optimize 0 -o dea0.out
dea0.out.c:1415:34: error: call to 'fn_yo_id_7544' declared with 'error' attribute:
  yo: the body of fn_yo_id_7544 failed to transpile — its definition-time evaluation
  failed and was swallowed (run yo check with YO_DEBUG_SWALLOW=1); this call would
  abort at runtime
 1415 |   bool _file____priv_temp_9634 = fn_yo_id_7544((__yo_t0)(x), (__yo_t0)(y));
2 errors generated.
yo: error: compile: C compiler failed (exit 1) on dea0.out.c

$ yo compile derive_eq_array.yo --std-path ./std --optimize 2 -o dea.out
Using system allocator            # rc=0
$ ./dea.out
before compare
$ echo $?
134
```

`--optimize 2` is what this repo's own build uses — `build.yo:48` sets
`optimize : build.Optimize.ReleaseSmall`, which `src/build_runner.yo:761-766` maps to
`--optimize 2` — and it is what every release build and the project's standing
compile guidance use. So on the builds that ship, the guard protects nothing.
It happens to work for a default `yo build` of a *user* project, whose
`std/build.yo:90` default is `Optimize.Debug` (`-O0`), which is the worst
possible split: the diagnostic appears in debug builds and vanishes in the
release build of the same source.

## Root cause

It is not the warning flags. `src/main.yo:1977-1983` already passes
`-Wno-everything` (not `-w`) plus `-Werror=return-type` on the optimized arm,
and the diagnostic is unaffected by either — reduced to plain C, `-O0 -w` and
`-O0 -Wno-everything` both still error.

It is the **shape of the stub**. The `error` attribute is a *backend*
diagnostic (`dontcall-error` in LLVM IR): clang raises it while lowering a
surviving call. The stub codegen emits is a function whose body is `abort()`,
so LLVM infers `noreturn` on it, and at `-O1` and above the diagnostic is
dropped even though the call is still there. Measured on clang 21.1.7,
arm64-apple-darwin, with the stub's exact shape:

```c
#include <stdio.h>
#include <stdlib.h>
__attribute__((error("BOOM")))
__attribute__((noinline)) static int bad(int x);
int main(int argc, char** argv){ (void)argv; printf("%d\n", bad(argc)); return 0; }
__attribute__((noinline)) static int bad(int x){ (void)x; abort(); }
```

| build | result |
| --- | --- |
| `clang -O0` | `error: call to 'bad' declared with 'error' attribute: BOOM` |
| `clang -O1` | **builds clean** |
| `clang -O2` | **builds clean** |
| `clang -O1 -g` / `-fno-inline` / `-fno-optimize-sibling-calls` | still builds clean |

The call has not been optimized away — the `-O1` assembly for `main` is
literally `bl _bad`, and the `-O1` IR still carries
`"dontcall-error"="BOOM"` on `@bad`. It is the diagnostic that is lost, not the
call.

The same happens for any never-returning body (an infinite loop in place of
`abort()` behaves identically), and it does NOT happen for a stub that can
return — a `return x + 1;` body is correctly diagnosed at `-O0`, `-O1` and
`-O2` alike. Since codegen deliberately writes `abort()` into every
value-returning stub (so the body does not fall off the end, which would be UB
— see `issues/ftt-stub-in-live-closure-falls-off-non-void-function.md`), the
guard is disabled by exactly the property it was written to guard.

## Fix

Keep the attribute (its message is excellent at `-O0`) and add a deadness
oracle that does not depend on the C optimizer. **Reference an undefined
external symbol from the stub body.** A dead `static` stub is discarded by the
C compiler and never emits the reference; a live one keeps it and the LINK
fails, at every optimization level:

```c
extern void __yo_body_failed_to_transpile__fn_yo_id_7544(void);   /* never defined */
__attribute__((error("yo: the body of fn_yo_id_7544 failed to transpile — …")))
static inline bool fn_yo_id_7544(__yo_t0 lhs, __yo_t0 rhs) {
  __yo_body_failed_to_transpile__fn_yo_id_7544();
  abort();
}
```

Measured, both directions, `clang -Wno-everything` at `-O0`, `-O1`, `-O2` and
`-O3`:

| stub | -O0 | -O1 | -O2 | -O3 |
| --- | --- | --- | --- | --- |
| live (called from `main`) | link error | link error | link error | link error |
| dead (never called) | builds | builds | builds | builds |

```
Undefined symbols for architecture arm64:
  "___yo_ftt_bad", referenced from:
      _main in link_live-5f0802.o
```

The symbol name is the diagnostic, so it must carry the Yo function name and
the words that tell the reader what to do — `__yo_body_failed_to_transpile__`
plus `c_function_name` reads acceptably in a linker error, and the attribute
still gives the full message whenever the C compiler does raise it. Emit the
`extern` declaration next to the attribute in
`src/codegen/functions/generation.yo:826-836`.

Two details to get right:

- The stub is `static inline`; the extern reference must be inside the body, so
  a discarded stub emits nothing.
- Chunked emission enables LTO (`chunk_lto_wanted`, `src/main.yo:2015`). An
  undefined symbol is still undefined under LTO, so the oracle holds; add a
  chunked-build case to the test below to keep it honest.

## Breaking change

No API change — but builds that currently succeed and ship a binary that
`abort()`s will start failing to link. That is the intent, and the failures are
pre-existing bugs surfacing, not new ones. Expect the first run over the corpus
to find some; each is a genuine swallowed def-eval error.

## Regression test

A codegen test (or a `tests/cli-cases` case, since the assertion is on the
build's exit code, not on program output) with two arms:

1. **Live stub must fail the build at every level.** A program with a swallowed
   def-eval body that IS called — e.g.
   `My :: enum(V6(s : Array(u16, usize(8)))); derive(My, Eq(My));` plus an
   `==` on it — must exit non-zero under `--optimize 0`, `1`, `2` and `3`.
   Today it fails only at `0`.
2. **Dead stub must still build.** `tests/fn.test.yo` and
   `tests/algebraic_effects.test.yo` carry markers on dead superseded-generic
   originals; they must keep passing at all four levels. That is the
   over-rejection canary, and it is the reason a text-scan or "any marker is
   fatal" rule was rejected before.
