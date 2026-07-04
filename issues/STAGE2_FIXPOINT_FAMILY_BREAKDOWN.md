# Stage-2 fixpoint — full family breakdown (133 clang errors)

**Date:** 2026-07-04
**Baseline:** HEAD (`8ac5ca44e`), yo-self-bin self-compiling `yo-self/main.yo` → C → clang.
**Measurement:** `clang -std=c11 -fno-strict-aliasing -fwrapv -w -O0 -ferror-limit=0 -c stage2.c`

## Divergence is confirmed and one-sided

Same `yo-self/main.yo` source, both compilers:

| Compiler        | stage output | clang errors |
| --------------- | ------------ | ------------ |
| TS (`src/*.ts`) | stage-1 C    | **0**        |
| yo-self-bin     | stage-2 C    | **133**      |

Identical input → the 133 errors are entirely **yo-self port divergence**, not shared
bugs and not inherent limitations. TS emits clean C for every construct here; yo-self
emits _different_ (broken) C. The divergence is the _incompleteness_ kind — the ported
machinery exists but does not fire for certain shapes — not an unfaithful shortcut.

## Top-level split (by enclosing C function)

| Bucket                    | errors | %   |
| ------------------------- | ------ | --- |
| **Async / effect family** | **92** | 69% |
| Non-async                 | 41     | 31% |

The async family is the dominant lever by a wide margin. It is **one root** with several
downstream symptoms (below), not 92 independent bugs.

---

## Family A — async / effect (92 errors)

**Root:** the `io.async` closure's await metadata does not reach the codegen-read closure.
`register_closure_await_analysis` is keyed by a `func_id`, but the closure is evaluated
more than once (def-time body eval + codegen-prep) and each eval mints a **fresh** func_id;
the codegen-read closure is a _clone_ evaluated without `is_inside_io_async_call`. When the
analysis lands under a func_id the codegen closure does not share, codegen sees
`io_async_await_analysis == None` and takes the **sync path instead of the FSM path TS takes**
— and on that sync path the `result := io.await(...)` statement is dropped (the LHS binding
types as `unit`, and codegen's init-assignment skips a unit-typed statement, discarding the
RHS with it).

Concrete proof (same `is_file`/statx closure, TS vs yo-self):

```c
// TS: state machine — await is a suspension point
sm->var_...buf_size = __yo_statx_buf_size();
__yo_io_future_t* _temp = fn_...statx((int32_t)(-2), (uint8_t*)cstr, ...);
if (__yo_effect_escaped) { sm->state = -2; ... }

// yo-self: flat sync body — await DROPPED, result never assigned
size_t buf_size = __yo_statx_buf_size();
uint8_t* buf = ...;
if ((() < ())) {            // was `result < i32(0)` — result resolved to unit
  ...
}
```

### Downstream symptoms of the single root

| Sub-family                                           | errors | example                                                                                 |
| ---------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| A1 dropped-await → `(() < ())` unit operand          | 12     | `if ((() < ())) {` (file.yo `is_file`/`exists`)                                         |
| A3 `__sync_future_N->field` member-ref on non-struct | 12     | `int __pre_await_state = __sync_future_38216->state` (`yo_id_400566`)                   |
| A2 `sm->result = closure_...()` return-type mismatch | 5      | `sm->result = closure_yo_id_7340(&sm->__capture, ...)`                                  |
| A4 other async-closure body cascade                  | 63     | `closure_yo_id_7629` (18), `yo_id_400971` (5), `yo_id_246193` (4), `yo_id_257430` (3) … |

Worst single function: `closure_yo_id_7629` — **18 errors** (an await-in-`while` closure:
dropped await → undefined `result`/`buf` → missing-type-specifier on the loop label,
double `__yo_free`, then a structural brace error as the malformed body unwinds).

**Fix direction:** make the await analysis + refined closure return type reach the
codegen-read closure regardless of func_id churn — either (a) restore
`is_inside_io_async_call` on the sticky `mark_closure_for_codegen` re-eval so the await
resolves to concrete during the eval codegen reads, or (b) key the await-analysis side-table
by something stable across the clone (the closure's _source_ expr identity, not the minted
func_id). (a) is closest to the TS model (TS keys await handling on the field/`ioBuiltin`
type, which the receiver value doesn't gate). Attempts to synthesize the await result on the
eval `.None` fallback path REGRESSED to 314 (over-triggers + drives a malformed sync-await
emission) — do not repeat; the fix belongs at the analysis-dispatch level, not the await-eval
fallback.

---

## Family B — Error.source trait-default fn not emitted (10 errors)

**Root:** the dyn-wrapper functions for the `Error` trait's `source()` method all call
`fn_yo_id_5802`, which is **never emitted**. The sibling `to_string()` wrappers resolve to
real specialized fns (`yo_id_227016`, `yo_id_5589`), so only the `source` trait-**default**
body is missing its specialization.

```c
static __yo_t67 __yo_wrap___yo_t378___yo_t65_source(void* self_ptr) {
  __yo_t378* concrete_value = (__yo_t378*)self_ptr;
  return fn_yo_id_5802(&concrete_value);   // fn_yo_id_5802 never defined
}
```

5 wrapper functions × 2 errors each (undeclared-fn + incompatible-return `int` vs `__yo_t67`).
**Fix direction:** the trait-default `source()` (returns `Option(Dyn(Error))`, default `.None`)
must be specialized and emitted for each impl that inherits it — same shape as the earlier
trait-`?=`-default fill fix (`dd7b0a78b`), but this default is consumed through the **dyn
vtable wrapper** path, which apparently doesn't request the specialization.

---

## Family C — generic-instantiation struct/enum identity mismatch (~11 errors)

**Root:** same-fielded generic instantiations get distinct struct/enum type ids, so a value
of `__yo_t549`/`__yo_t601`/`__yo_t218`/`__yo_t321`/… is initialized/passed where a
structurally-identical but differently-id'd type is expected. This is the classic layer-2
struct-identity family (task #30) surfacing in generic-heavy call paths.

Representative functions (all `yo_id_13321_*` / `yo_id_13332_*` = generic instantiations,
plus `yo_id_251116/252395/346587/357219` passing `__yo_t601` = `<enum:enum_yo_id_251312>`):

```
L40028  initializing '__yo_t549' with incompatible type ...
L202910 passing '__yo_t601' to parameter of incompatible type ...
L79623  initializing '__yo_t218' with incompatible type ...
```

**Fix direction:** extend the codegen stable-type-identity keying (the same-fielded
instantiation collapse) to these enum/struct instantiations. Needs per-case confirmation
that the two ids really are structurally identical (vs a genuine eval type divergence).

---

## Family D — `__yo_cond_create` pointer/int mismatch (5 errors)

```
L12698 assigning to '__yo_t371 *' ... incompatible integer to pointer conversion
```

`sm->result = closure_...()` inside a cond-lowering — the cond-result temp's C type
(pointer vs the closure's int/bool return) disagrees. Likely coupled to Family A (the
closure return type is the FSM `result` slot); may resolve once A lands. **Verify after A.**

---

## Remaining scattered (≤2 each, ~8 errors)

`expected expression` / misc in `yo_id_264520`, `yo_id_306050`, `yo_id_400958`,
`yo_id_360511`, `yo_id_289175`. Individually small; triage after the big families drain.

---

## Priority order

1. **Family A (92, 69%)** — async await-analysis dispatch to the codegen-read closure. One
   root, unblocks the entire majority. Highest value by far.
2. **Family B (10)** — Error.source trait-default specialization through the dyn wrapper.
   Self-contained, well-understood shape.
3. **Family C (~11)** — generic-instantiation type-id collapse. Per-case verification needed.
4. **Family D (5)** — likely falls out of A; recheck afterward.
5. Scattered (~8) — triage last.

Fixing A + B alone would take 133 → ~31 (a 77% cut) if each root resolves cleanly.
