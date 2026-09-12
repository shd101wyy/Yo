# A `Box` over an `Impl(Fn(...))` is emitted as TWO C structs, and the return type mismatches

**Status:** OPEN. **Found:** 2026-09-13, from develop's first full battery to
finish since the merge storm.
**Severity:** ill-typed C everywhere; a hard ERROR on exactly one CI leg.

## Symptom

```
tests/.yo_selftest_batch_36_0.bin.c:5079:10: error: incompatible pointer types
  returning '__yo_t_5752942365119613889 *' from a function with result type
  '__yo_t_14875819487774288075 *' [-Wincompatible-pointer-types]
```

Two of them, from `tests/closure_param_forwarding.test.yo`.

**It is a hard error on `test (windows-11-arm)` only, and that is an accident of
toolchain, not of platform.** That leg is the sole runner that installs clang 22,
where `-Wincompatible-pointer-types` is a default ERROR; `test.yml` calls it
"the strictest C-conformance runner" for exactly this reason. Every other
platform compiles the same defect as a WARNING and runs the result. So this is
not a Windows bug — it is a latent bug the other legs are too permissive to
fail on.

## What the two types are

Reproduced on macOS arm64 (as warnings), then read out of the emitted C:

```c
struct __yo_t_5151165989142611580_struct { // Box( : (Fn(i32) -> i32))
  __yo_ref_header_t header;
  __yo_t_14341667753047648521 _u42_;
};
struct __yo_t_12134693802553570606_struct { // Box(<struct:capture_3301701560438262587>)
  __yo_ref_header_t header;
  __yo_t_14341667753047648521 _u42_;
};
```

**Identical layout, identical payload type.** They are ONE Yo type emitted under
two C names: the box keyed once on the UNRESOLVED `Impl(Fn(i32) -> i32)` and
once on the RESOLVED capture struct that SomeT points at. The function's
signature took the first spelling and its body's `__yo_new_…` took the second:

```c
static inline __yo_t_5151165989142611580* …_cl0_closure_…(__yo_t_14341667753047648521 value) {
  …
  __yo_t_12134693802553570606* tmp = __yo_new___yo_t_12134693802553570606(value);
  return tmp;
}
```

Because the layouts agree, the program RUNS correctly — which is why it has
survived as a warning. It is still ill-typed C, and it is one `type_key` away
from being a genuine miscompile the moment the two spellings stop agreeing on
layout.

## It is a REGRESSION since v0.2.31

Measured, same test file, same machine:

| compiler | `incompatible pointer` warnings |
| --- | --- |
| published **v0.2.31** seed | **0** |
| develop's tip | **2** |

The file's pre-#598 revision produces 2 under develop's compiler as well, so the
tests #598 ADDED are not the trigger — the compiler is. The suspect is #598
itself (`codegen: a static-dispatch call takes its C return type from the
CALLEE`), which introduced `resolve_some_type_to_concrete` into
`declarations.yo` and changed which channel three emitters read. Resolving the
SomeT on ONE side and not the other is precisely how two C names for one type
appear. **That is a strong hypothesis, not yet a measurement**: the deciding A/B
is a compiler built from `15e21b752^` against the same file, which was started
and killed for memory (a 9 GB peer compile held the machine).

## Why every local gate missed it

`yo test` scores the RUN, and the run passes: 4/4 locally, exit 0. A clang
warning is invisible to it. The CLI corpus, the fixpoint and `check` never see
it either. Only a compiler strict enough to reject it fails, and there is
exactly one such leg in the matrix.

**The gate this deserves is a warning ratchet on the emitted C** — the same
shape as `scripts/bootstrap/known-failing.tsv`: count `-Wincompatible-pointer-types`
(and its siblings) in a suite emit and fail on any INCREASE. Without it the
next instance is invisible again until someone reads a windows-11-arm log.

## Next step

1. Finish the A/B: build `15e21b752^` and count the warnings on the same file.
   If 0, the fix belongs in whichever of #598's three emitters started
   resolving; if 2, the regression is older and the bisect continues backwards.
2. Whichever side is found to have changed, the FIX is to make both agree —
   one type must have one `type_key`. Resolving the SomeT before keying is the
   direction the rest of codegen already takes
   (`resolve_some_type_to_concrete` reads the per-object cell then the global
   registry).
