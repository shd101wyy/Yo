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
tests #598 ADDED are not the trigger — the compiler is.

**CORRECTION 2026-09-13 — the "#598 is confirmed" claim below was WRONG, and
is left standing with its refutation because the mistake is the instructive
part.** The A/B compared a build at `15e21b752^` against develop's tip, and
those are **48 commits apart**, not one. The tell was in the emitted C the whole
time and went unread: the two files use different type-NAMING schemes
(`__yo_t21` vs `__yo_t_5151165989142611580`), which is `#603`
(`codegen/evaluator: content-stable symbol names (Phase 2)`) — a commit in the
same range that touches `src/types/type_key.yo`, the file that decides whether
two spellings of one type get one C name or two. A keying change is a far better
candidate for "one Yo type, two C structs" than a return-type-spelling change.

So what is actually established is: **the regression is somewhere in
`15e21b752^..develop`**, and `#603` is now the prime suspect, `#598` a
secondary one. What follows is the measurement, which stands; only the
attribution was over-claimed.

**MEASURED 2026-09-13: a regression in the 48-commit range** (`codegen: a static-dispatch
call takes its C return type from the CALLEE`). A compiler built from
`15e21b752^` was measured against the SAME file in the SAME tree:

| compiler | `incompatible pointer` warnings | `Box` structs emitted |
| --- | --- | --- |
| published v0.2.31 seed | 0 | — |
| built from `15e21b752^` (pre-#598) | **0** | **3**, every one `Box(<capture>)` |
| develop's tip | **2** | **5** — the same 3 PLUS two `Box( : (Fn(i32) -> i32))` |

So #598 causes an UNRESOLVED spelling of the box to reach C-type emission
alongside the resolved one, and a function then takes its signature from one and
its body's constructor from the other.

Note what the pre-#598 binary does on that same file: it fails with
`initializing 'void *' with an expression of incompatible type 'void'` — which
is the bug #598 EXISTS to fix. Both mismatches are real; #598 traded one for the
other. Any fix must keep #598's `T = unit` test passing, and that test is the
guard against trading back.

## Hypotheses already disproven (do not re-spend these)

* **"`emitted_return_type_string` mints the struct by calling `get_type_string`
  on an unresolved result."** Resolving it there with
  `resolve_some_type_to_concrete` changes NOTHING — measured, still 2 warnings.
  Two reasons: `resolve_some_type_to_concrete` unwraps only a TOP-LEVEL SomeT
  and this is a `Box(...)` CONTAINING one; and `get_type_string` does not mint
  at all — `_lookup_named_c_type` PANICS on an unregistered type, so by the time
  it is called the struct already exists.
* Therefore the extra structs are created by the type-COLLECTION pass, not by
  any emission-time reader. That is where the next probe belongs: find what
  makes collection see `Box(Impl(Fn))` after #598 and not before.

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

The A/B is done and #598 is named. What is NOT yet known is which of its three
changed emitters puts `Box(Impl(Fn))` in front of the type-collection pass,
and the two obvious emission-time candidates are disproven above.

1. NARROW THE RANGE FIRST — it is 48 commits, not one. Build at `577d555ad`
   (#603 itself) and count: 2 warnings puts the cause at or before #603, 0 puts
   it after. That is one build and it halves the range with the suspect on the
   boundary. Do NOT repeat the mistake above of reading a 48-commit A/B as a
   one-commit one; check the emitted C for unrelated wholesale changes (the
   type-naming scheme was the giveaway) before attributing.
2. Only then probe the type-collection pass: log every type registered under a
   key whose rendering starts `Box( : (Fn`, and compare the two runs of the same
   file. Collection runs once, so this is a small log and names the caller.
3. The FIX is then to make both spellings agree — one Yo type must have one
   `type_key`. Note that the needed resolution is DEEP (through a struct's type
   arguments); `resolve_some_type_to_concrete` is top-level only and codegen
   has no deep equivalent today, so one may have to be written.
4. Keep #598's `T = unit` arm in `tests/closure_param_forwarding.test.yo` green
   throughout — it is the guard against reintroducing `void* t = <void call>`.

Until it is fixed, `test (windows-11-arm)` stays red on every PR, because that
leg is the only one that treats this as an error.
