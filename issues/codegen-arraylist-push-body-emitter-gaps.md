# ArrayList(u8).push() body — emitter gaps (post return-body-spec fix)

**Status:** OPEN. Surfaced after the return-body specialization fix (f2cf25e79)
made `ArrayList(u8).push()` *specialize* correctly (T→u8). The call site and
specialization are now correct; the remaining failures are all inside the
specialized push **body**.

## Repro

`/tmp/push1.yo`:
```rust
pragma(Pragma.AllowUnsafe);
{ ArrayList } :: import("std/collections/array_list");
{ putchar } :: import("std/libc/stdio");
main :: (fn() -> unit)({
  al := ArrayList(u8).new();
  al.push(u8(65));
  al.push(u8(66));
  n := al.len();
  unsafe(putchar(int(i32(usize(48) + n))));
});
export(main);
```
TS prints `2`. self-bin: `main` body is CORRECT
(`yo_id_3753(al,65)`, `yo_id_3739(al)`), but the C fails to compile — the push
body (`yo_id_3753`) contains these `// Failed to transpile` forms:

1. `(GlobalAllocator.realloc)(.Some(*(void)(old_ptr)), sizeof(T)*new_capacity)`
   and `(GlobalAllocator.malloc)(...)` — **comptime-namespace method dispatch**
   (`GlobalAllocator` is a comptime value bundling malloc/realloc/free).
2. `*(T)(new_ptr)` — **raw-pointer cast** `*(T)(ptr)` (deref-cast to typed ptr).
3. `.Some(typed_ptr)` — **enum constructor in value position** assigned to a
   `?*(T)` field (runtime pointer payload).
4. `typed_ptr &+ (self._length)` — **pointer arithmetic operator `&+`**.

Each is a separate emitter gap. Also note `sizeof(T)` appears unsubstituted in
the realloc/malloc args (T should be u8 in the specialized body) — verify
whether the spec body substitutes T into `sizeof(T)`.

## Re-confirmed 2026-06-16 (after return-body + match-arm fixes — both unrelated)

Current `push1.yo` push-body failures (verbatim):
```
_tmp = // Failed to transpile (GlobalAllocator.realloc)(.Some(*(void)(old_ptr)), sizeof(T) * new_capacity);
_tmp = // Failed to transpile (GlobalAllocator.malloc)(sizeof(T) * new_capacity);
uint8_t* typed_ptr = // Failed to transpile *(T)(new_ptr);
self->_ptr = // Failed to transpile .Some(typed_ptr);
uint8_t* target_ptr = // Failed to transpile typed_ptr &+ (self._length);
```

### CORRECTION 2026-06-16: there is NO T-substitution gap
An earlier note here claimed `T` was unsubstituted in the specialized push body
(from `sizeof(T)`/`*(T)` in the "Failed to transpile" lines). That was a MISREAD:
those strings are the **source-text echo** (`ast_expr_to_string` of the
un-transpiled expr in the `// Failed to transpile <src>` comment), NOT the lowered
type. The TRANSPILED lines prove T is correctly substituted to `u8`:
`uint8_t* old_ptr`, `uint8_t* typed_ptr`, `uint8_t* target_ptr`, and `self->_ptr`
typed `uint8_t*`. So the blockers are PURELY the emitters below (a `*(T)` cast
would correctly emit `(uint8_t*)`), not generic substitution.

### ✅ `*(T)(ptr)` pointer cast — FIXED 2026-06-16 (commit d8a23ab2a)
Resolved together with runtime numeric casts: both `*(T)(ptr)` and `i32(runtime)`
were rewritten to `__yo_as` by the eval but the rewrite never reached codegen
(returned new node, codegen walks the original). Fixed via the original node's
`macro_expansion` → fresh-id `__yo_as` node. The `*(T)(new_ptr)` line is gone from
push1's failures.

### Progress 2026-06-16 — 3 of 4 push-body gaps FIXED
- ✅ `*(T)(new_ptr)` pointer cast — fixed (d8a23ab2a, runtime casts).
- ✅ `.Some(typed_ptr)` nullable-pointer enum ctor — fixed (93f1cc91c).
- ✅ `typed_ptr &+ (self._length)` pointer arithmetic — fixed (59f147cf3,
  `&`-prefixed ptr operators lower to ptr-builtin inlines).
- ✅ `GlobalAllocator.malloc/realloc` DISPATCH itself — CONFIRMED WORKING in
  isolation (`/tmp/galloc.yo`, `/tmp/grealloc.yo`: `__yo_malloc(8ULL)` /
  `__yo_realloc(m, 16ULL)` emit + run correctly, even with a parenthesized callee).

REMAINING (1 gap, deep): push's `(GlobalAllocator.malloc)(sizeof(T) * new_capacity)`
and the realloc line still emit "Failed to transpile" — NOT the allocator dispatch
(works isolated) but the `sizeof(T) * new_capacity` ARG in the SPECIALIZED push
body. `sizeof(<concrete struct>)` emits fine elsewhere in the same C; only
`sizeof(T)` (the type-param) in the spec-method-body arg position fails the outer
call. Isolation is tricky: a `forall(T)` free fn can't be called with an explicit
`u8` (malformed for TS too); a generic-struct method `grow` calling
`malloc(sizeof(T)*cap)` (`/tmp/gsz2.yo`) surfaced a DISTINCT sub-issue — the
generic unit-returning method CALL `b.grow(...)` itself isn't dispatched (becomes
a no-op), so it doesn't cleanly reproduce push (whose `push` body IS emitted, with
only the malloc/realloc arg lines failing). Next: probe generate_other_function_call
for the push malloc call — is the `sizeof(T) * new_capacity` arg generation
returning empty (sizeof's type-arg T unresolved in the spec body), or is the call
dispatch itself bailing? Tie this to the generic unit-method-call-dispatch gap
gsz2 surfaced.

### Isolation note (2026-06-16): entangled, multiple facets — needs a fresh probe session
Attempts to isolate the push `sizeof(T)*cap` gap each surfaced a DIFFERENT facet:
- `/tmp/gsz2.yo` (generic `grow(self,cap)->unit` with `malloc(sizeof(T)*cap)`):
  the CALL `b.grow(..)` isn't dispatched (no-op) — generic UNIT-returning method
  with a runtime-op body.
- `/tmp/szof.yo` (generic `szof(self)->usize` returning bare `sizeof(T)`):
  `sizeof(u8)` is COMPTIME-folded (u8 concrete) → `n := b.szof()` then
  `putchar(48+n)` "Failed to transpile" — a comptime-method-result-usage path,
  NOT push's runtime `sizeof(T)*cap`.
So the push remainder is entangled with (a) generic-method dispatch for
unit/comptime-result methods, (b) comptime-folded-method-result usage, and (c)
the runtime `sizeof(T)*cap` arg in a spec body. Tackle with dedicated probe builds
(instrument the method-call spec path: does the spec FuncVal get recorded in
g_method_callee_values for these methods? does the spec body eval throw?), not
one-fixture-at-a-time guessing.

### PROBE RESULT (2026-06-16): the method-record site is NOT reached
Instrumented function.yo:2677 (the `.None` receiver-method-dispatch arm where
`record_method_callee_value` + the spec live), gated on the call source containing
"szof"/"grow". A `--release` build + run on `szof.yo`/`gsz2.yo`/`gc2.yo` printed
**ZERO** PROBE_METH lines — even for the WORKING `gc2` (MyBox.get). So generic
instance-method calls (`b.szof()`, `b.grow()`, and even the working `b.get()`) do
NOT dispatch through that arm; they take a DIFFERENT method-eval path (consistent
with the old memory note that `s.len()`/`v.to_string()` bypass function.yo:2535).
=> The "spec produces NOSPEC" hypothesis below is UNCONFIRMED at that site; the
real fix requires first TRACING which eval arm actually resolves+dispatches
`b.<method>()` for a generic instantiation (candidates: inline-FuncVal arm at
function.yo:1616, property-access-resolves-to-FuncVal, or the runtime-return spec
at ~2355). Probe the TOP of evaluate_function_call to see which branch `b.szof()`
enters, THEN locate where (if anywhere) its spec runs / its callee value is
recorded for codegen. This is a deep, multi-facet generic-method-dispatch trace
(every probe so far has relocated the target) — a dedicated systematic-trace
session, not one-fixture probing.

### REFINED COMMON-ROOT HYPOTHESIS (2026-06-16, UNCONFIRMED — see probe result above)
Both `szof` (value-return, `sizeof(T)` body) and `grow` (unit-return, `malloc`
body) fail to DISPATCH (`b.szof()`/`b.grow()` → "Failed to transpile"), while
`gc2`/MyBox.get (`self.value` body) dispatches fine. The differentiator is the
method BODY content: methods whose body uses `sizeof(T)` / runtime allocator ops
don't get dispatched. Likely mechanism: the generic-impl method's spec-body eval
(create_specialized_function_inline) fails/throws on the `sizeof(T)`/malloc body,
so `spec_func_val` is None and `record_method_callee_value` never stores a usable
FuncVal → codegen's concrete/generic method dispatch can't resolve the call →
bails. This ALSO explains why push (ArrayList.push) shows its body emitted with
only the malloc/realloc arg lines failing — push gets dispatched via a different
path (heavily used, collected) but its spec body's `sizeof(T)*cap` arg still fails.
NEXT PROBE (single build): instrument function.yo's method path —
`record_method_callee_value` site + the create_specialized_function_inline call —
to print, for `szof`/`grow`, whether spec_func_val is Some and whether the spec
body eval threw. Then fix the spec-body-eval failure for sizeof(T) bodies.

### (historical) Remaining emitter gaps (isolate each)
- comptime-namespace method dispatch: `GlobalAllocator.realloc/malloc` (callee is
  a comptime value bundling fns — resolve to the bundled fn + emit a normal call).
- `*(T)(ptr)` raw-pointer cast (deref-cast); note `.Some(*(void)(old_ptr))` shows
  `*(void)` too — the void-ptr deref-cast form.
- `&+` pointer arithmetic — NOT a direct `__yo_ptr_add` inline (corrected): in TS
  (`_expr.ts:1222`) `&+` is only unsafe-gated then dispatched as a NORMAL call;
  `&+` is a pointer OPERATOR-METHOD whose body calls `__yo_ptr_add`. So codegen
  must dispatch the `&+` operator method (then the inner `__yo_ptr_add` lowers via
  the inline path). Same operator/method-dispatch complexity class as the others —
  NOT a one-liner.
- `.Some(ptr)` runtime enum-ctor into a `?*(T)` field — NOT a cascade (still fails
  after the `*(T)` fix). Finding: the nullable-pointer `Option(*(u8))` lowers to a
  bare `uint8_t*` (nullable-pointer optimization, `can_optimize_as_nullable_pointer`),
  so `.Some(ptr)` for that representation should emit just `ptr` (and `.None` →
  `NULL`). The enum-construction codegen is missing the nullable-pointer-optimized
  `.Some`/`.None` case. Port the TS branch that emits the bare pointer. (Isolating a
  standalone repro needs care — `&(x)` address-of type vs `?*(u8)` annotation
  mismatched in a quick attempt; use a fixture that mirrors the std `_ptr` field
  shape, or test via push1 once GlobalAllocator dispatch lands.)

Build isolated corpus fixtures per gap. Each needs `unsafe`/raw-ptr scaffolding.
