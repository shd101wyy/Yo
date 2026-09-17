# A `comptime(...)` parameter given a non-comptime argument emits BROKEN C instead of an error

**Status:** OPEN. **Reported:** 2026-09-17 by the peer session (yo-12) while
root-causing `Array(T, N).fill(T.default())`; handed over because it is the
same family as the diagnostics-flattening work in #733.

**Verification status:** the reproducer and the clang error below are the
REPORTER's measurement, quoted as given. I have not independently reproduced
them yet — stated explicitly so nobody treats this as twice-confirmed. The
mechanism claim at the bottom is mine and is REASONED, not measured.

## Reproducer

```rust
c :: (fn(comptime(v) : i32) -> i32)(v);
main :: (fn() -> unit)(println(`${c(i32.default())}`));
```

`i32.default()` is a plain runtime `fn` (`impl(i32, Default(default :
(fn() -> Self)(i32(0))))`), so its call yields `UnknownVal` — it is NOT
compile-time folded. Confirmed three ways by the reporter:
`comptime_assert(i32.default() == i32(0))` gives **E1101** (the comparison is
not a comptime bool), while `println(`${i32.default()}`)` prints `0` correctly.

So `c` demands a comptime argument and is given a runtime one. That is a
genuine user-level error.

## What happens instead

No Yo-level diagnostic at all. The evaluator accepts it and codegen emits a
call with the argument DROPPED. The only oracle is the C compiler:

```
error: too few arguments to function call, single argument 'v' was not specified
```

rc is 1 **only because clang caught it**. Nothing in the Yo layer objects.

## Why this is the worse half of a pair

The reporter found two silent degradations from the same investigation and is
fixing the other one (`__yo_array_fill` accepting an `UnknownVal` fill value
and manufacturing `create_unknown_val(array_type)` for the whole array — its
correct diagnostic sits four lines above but is guarded on `fv_info.value`
being `.None`, and a runtime-unknown arrives as `.Some(UnknownVal)`, so it
never fires: the `.None` vs `UnknownVal` trap in its purest form).

This one is worse in shape. The array case at least ends in a loud
`FATAL: … whose body failed to transpile`. Here the compiler emits C that is
simply wrong, and a C compiler that happened to accept it would have shipped a
call with a missing argument.

## 2026-09-17 UPDATE: this and the `Array.fill` defect are probably ONE defect

The reporter's fix for the sibling `Array.fill` issue **did not work**, and the
refutation unified the two. Built on `d126e2c90`, the negative case compiled
rc=0 with the new diagnostic absent:

```
error: Expected compile error, but the expression was evaluated successfully:
(Array(i32, usize(3)).fill)((i32.default)())
```

**Why:** `fill`'s body is `return(__yo_array_fill(Self, val))`, and the
unknown-arg execution gate in `src/evaluator/calls/comptime_fn.yo` returns
`_ctfe_unknown(return_type)` **without running the body**. So
`evaluate_yo_array_fill` never executes on this path and a guard placed inside
it sits in code the defect never reaches. The reporter's own earlier probe had
already measured that skip (`[ctgate] any_arg_unknown=true`) and it was read as
confirming the array location. **The data predicted the refutation hours before
the refutation.**

Both cases are then the same thing — an `UnknownVal` argument bound to a
`comptime(...)` parameter:

| case | signature | downstream symptom |
| --- | --- | --- |
| this issue | `c :: (fn(comptime(v) : i32) -> i32)(v)` | C emitted with the argument DROPPED; only clang objects |
| `Array.fill` | `(fn(comptime(val) : T) -> comptime(Self))` | `_ctfe_unknown` → abort stub |

### Proposed interception (REASONED FROM MEASUREMENT — not yet measured)

At that unknown-arg gate the callee fid is in hand, and
`get_func_param_comptime(fid)` (`src/evaluator/types/function.yo`, exported,
four consumers in `calls/helper.yo`) gives the per-parameter comptime flags. An
argument that is unknown AND bound to a parameter flagged `comptime` is
unambiguously a user error, so throw there, gated on `!in_def_time_trial()`
(during a trial the generics are unbound by construction).

**MEASURED:** the body is skipped; the registry exists; the non-trial skip
occurs (the ctgate skip fires twice for `fill`, only the first inside a trial).
**NOT MEASURED:** that throwing there fixes BOTH cases without breaking
legitimate generic code. The suite is the oracle.

**The open question before anyone implements this**, and it is why the
one-defect claim is "probably": the gate is measured to fire for `fill`, NOT
for the `c1` case in this document. The differing symptoms are evidence the
paths may diverge — `fill` returns an unknown and never reaches codegen, while
`c1` reaches clang, which is codegen running to completion. **Run the ctgate
trace on `c1` first.** If `any_arg_unknown=true` fires for it too, one
interception point covers both. If it does not, these are two defects sharing
an upstream cause, and fixing only the gate would close this issue while
leaving the `c1` face untouched.

### Diagnostic shape

Name the parameter, say the argument is a runtime value, and point at the fix
(pass a literal or a `comptime_fn`). **Attach no `Repair`** — there is no
unique edit, and a repair must only ever be set where exactly one edit fixes
the error. Since #733 landed, a typed error thrown here survives the def-time
trial and reaches `--error-format json`, `yo fix` and the LSP rather than being
flattened to text, which is why this belongs as a real diagnostic.

**Implementation is owned by the reporter (yo-12)**, who has the built tree and
both reproducers; this document stays the issue of record.

## Suspected mechanism, as first filed (REASONED, not measured — superseded by the section above)

The `comptime(...)` parameter path binds the parameter at specialization time
and the emitter then treats it as compile-time-substituted, so it emits no
runtime argument for it. When the argument is NOT comptime, the binding
silently does not happen and the call is emitted with the parameter elided
anyway. The check that should reject this — "this parameter is `comptime` and
the argument's value is unknown" — appears to be absent rather than
misguarded, unlike the `fill` case.

**Do not implement from that paragraph.** The last three defects in this area
were each fixed at a site that plausible reading had ruled in and measurement
ruled out (#733's own issue prescribed the wrong path). Instrument the
comptime-parameter binding and the call emitter, confirm which one drops the
argument, and only then write the diagnostic.

## What a fix should produce

An error at the CALL SITE naming the parameter and why: the parameter is
`comptime`, the argument is a runtime value, and the fix is to pass a literal
or a `comptime_fn`. The machinery to carry it now exists — diagnostics survive
the def-time trial as of #733, so a typed error raised here reaches
`--error-format json`, `yo fix` and the LSP rather than being flattened.

## Related

- `issues/fixed/evaluator-diagnostics-are-flattened-to-strings-before-the-typed-stash.md` (#733)
- the reporter's `issues/array-fill-rejects-a-generic-dispatched-comptime-value.md`
  (title is known-stale: the generic framing was the reporter's own error, and
  the variable is literal-vs-call, not generic-vs-concrete)
- `plans/archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md` — the class this belongs
  to: a toolchain that reports success for work it did not do.
