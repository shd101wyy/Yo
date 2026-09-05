# A value boxed into a `Dyn` is never dropped — an `own` parameter of a generic function loses its scope-end drop

**Status:** FIXED 2026-09-05 (PR `fix/dyn-box-dispose-empty-body`) — the leak's
real cause was NOT the empty dispose body this doc was originally filed for; see
"What it actually was" below. The empty dispose is fixed too (it is dead code,
so it was never the leak).
**Found:** 2026-09-04, measuring the `error`/`assert` row of the std API audit —
a three-line `AnyError` program leaks under `leaks -atExit`.
**Severity:** memory-unsafety (unconditional leak; no use-after-free — the box
itself is freed, only the value inside it is not released).

## Symptom

```rust
{ AnyError } :: import("std/error");
open(import("std/string"));
open(import("std/fmt"));

main :: (fn(io : Io) -> unit)({
  (inner : AnyError) = dyn(`disk full`);
  println(`done`);
});
export(main);
```

```
$ yo compile d4.yo --optimize 2 --allocator system -o d4.out
$ leaks -atExit -- ./d4.out
Process 73848: 2 leaks for 80 total leaked bytes.
STACK OF 1 INSTANCE OF 'ROOT LEAK: <malloc in __yo_user_main>':
    2 (80 bytes) ROOT LEAK: <malloc in __yo_user_main 0xb01034000> [48]
```

The same program with a plain `String` local instead of the `AnyError` leaks
`0 leaks for 0 total leaked bytes`.

It is not specific to `String`, and not specific to a local: the blessed
`exn.throw(dyn(err))` idiom leaks its payload too —

```rust
{ AnyError, Exception, Error } :: import("std/error");
open(import("std/string"));
open(import("std/fmt"));

IoErr :: enum(NotFound(path : String));
impl(IoErr, ToString(to_string : (fn(inout(self) : Self) -> String)(match(self, .NotFound(p) => `not found: ${p}`))));
impl(IoErr, Error());

risky :: (fn(exn : Exception) -> i32)(exn.throw(dyn(IoErr.NotFound(path : `/tmp/x`))));

main :: (fn(io : Io) -> unit)({
  exn := Exception(throw : (err -> { println(`caught: ${err}`); unwind(()); }));
  _r := risky(exn);
  println(`done`);
});
export(main);
```

`2 leaks for 64 total leaked bytes`, while the identical program throwing a
PAYLOAD-FREE variant (`IoErr :: enum(NotFound)`) leaks 0. The leaked bytes are
the boxed value's own RC allocations.

## The originally filed root cause — REFUTED

The doc originally blamed `generate_dyn_box_functions`
(`src/codegen/functions/dyn.yo`), which emits

```c
static void __yo_dispose___yo_dyn_box___yo_t4(void* ptr) {
  __yo_dyn_box___yo_t4* box = (__yo_dyn_box___yo_t4*)ptr;
}
```

— a dispose with an empty body, because `get_drop_function_for_type` resolves
only a USER `___drop` METHOD and the `.None` arm did nothing.

That emission IS defective, but it is **not what leaks**: nothing in the
self-hosted compiler ever calls `__yo_new___yo_dyn_box_<T>`
(`grep -rn '__yo_new___yo_dyn_box' src/` finds the declaration and the
definition, no call site). The whole `__yo_dyn_box_*` family is vestigial from
the TypeScript port. `dyn(v)` lowers differently:

- **ref type** — the fat pointer's `.data` IS the existing RC handle; no box.
- **value type** (`String`, a value struct, a value enum) — the evaluator boxes
  through the PRELUDE's `Box(V)`, i.e. `std/prelude.yo`'s
  `box :: (fn(generic(V : Type), own(value) : V) -> Box(V))(Box(V)(value))`.

Instrumenting the reproducer's C confirms it: the object under the fat pointer
is `Box(String)` with `type_id = 1`, and its dispose (`yo_id_7429`) is CORRECT —
it drops the String. What actually leaked was the String's `ArrayList` buffer,
one refcount above zero.

## What it actually was

The `box` body emits an unmatched `___dup`:

```c
static inline __yo_t11* yo_id_3192_...(__yo_t0 value) {
__yo_t1 temp_dup_enum_yo_id_7428 = value;
switch ((temp_dup_enum_yo_id_7428).tag) {
  case __YO_T1_SOME: {
    (temp_dup_enum_yo_id_7428).data.Some.value = ((__yo_t2*)__yo_incr_rc(...));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_7428;
  __yo_t11* _file____User_temp_9085 = __yo_new___yo_t11(value);
  return _file____User_temp_9085;          // <-- no scope-end drop of `value`
}
```

The identical MONOMORPHIC shape emits the matching drop and does not leak:

```rust
W  :: ref(struct(v : String));
mk :: (fn(own(value) : String) -> W)(W(v : value));   // 0 leaks
```

while the generic one leaks:

```rust
W  :: (fn(comptime(V) : Type) -> comptime(Type))(ref(struct(v : V)));
mk :: (fn(generic(V : Type), own(value) : V) -> W(V))(W(V)(v : value));  // 2 leaks
```

**Root cause.** `own(name) : T` means the caller TRANSFERS a reference (the
caller's argument is marked consumed), so the callee owns it and must release it
at scope end. `begin.yo`'s function-body parameters-frame pass
(`evaluate_begin_expression` → `_schedule_scope_end_drops(..., params_only :
true)`) schedules exactly that drop — but its gate is
`v.is_owning_the_rc_value`, and only ONE of the three places that bind a
parameter set that flag from the declared `own` modifier:

| binder | site | `is_owning_the_rc_value` |
| --- | --- | --- |
| def-time body env | `_build_def_time_body_env`, `src/evaluator/calls/function_type.yo` | `p_own` ✅ |
| FuncVal runtime call | `_evaluate_funcval_runtime_call`, `src/evaluator/calls/function.yo` | hardcoded `false` ❌ |
| call-time param match | `check_if_function_parameter_matches_argument`, `src/evaluator/calls/helper.yo` | hardcoded `false` ❌ |

A function with `generic(...)` parameters **defers its body evaluation**
(`should_defer_ft`, `function_type.yo`) — so its body is never evaluated against
the def-time env, only against the call-time binding. Every `own` parameter of
every such function therefore lost its scope-end drop, while the body's store
still emitted the balancing `___dup`: a net +1 on every call.

`box` is the highest-traffic instance, and `dyn(value_type)` goes through it, so
this leaked on every `Dyn` payload and — since `AnyError` is `Dyn(Error)` — on
every thrown error carrying a `String`, struct or enum payload. But the class is
WIDER than `box`: on the pre-fix compiler even

```rust
ident :: (fn(generic(V : Type), own(v) : V) -> V)(v);
```

never released its argument. Every `own` parameter of every generic function
leaked, whatever the body did with it (return it, move it through a local,
store it in a struct, or ignore it entirely).

## Fix

1. `src/evaluator/calls/function.yo` — `_evaluate_funcval_runtime_call` binds
   the parameter with the declared `own` flag
   (`fv_param_is_owning.get(pi)`) instead of `false`. **This is the change that
   fixes the leak.**
2. `src/evaluator/calls/helper.yo` — the same one-word fix at the sibling
   call-time binder (`param_is_owning` instead of `false`), so all three binders
   agree with the def-time one.
3. `src/codegen/functions/dyn.yo` — the dyn box dispose now falls back to the
   STRUCTURAL drop (`generate_drop_code_for_value`) when no user `___drop`
   method exists, and looks both up through the RESOLVED concrete
   (`dyn_concrete_res`) that the box typedef and constructor already use. When
   the payload contains RC state and neither path emitted anything, it leaves a
   greppable `/* __yo_MISSING_DROP: ... */` marker instead of a silent no-op.
   This is dead code today (nothing constructs a `__yo_dyn_box_*`), so it
   changes no behaviour — it removes the landmine.
4. `src/codegen/exprs/downcast.yo` — **the other half of the same bug, and a
   use-after-free the moment the leak was fixed.** `generate_downcast` extracts
   a value/newtype target out of the Box's value field and is supposed to dup
   it ("the Box retains its copy"), but it only did so when
   `get_dup_function_for_type` found a USER `___drop`-style `___dup` METHOD.
   Most types have none — `String`, a value enum with RC payloads, a value
   struct with RC fields are all dup'd STRUCTURALLY — so the `.None => extract`
   arm handed out an UN-dup'd copy of a value the Box still owned. While `box`
   leaked a reference that over-count masked it exactly; with the refcount
   exact, the caller's scope-end drop and the Box's dispose released the same
   allocation. ASan caught it on BOTH Linux legs of PR #428 as
   `heap-use-after-free in __yo_decr_rc` under `Test String as Error via
   AnyError`, at the same address on x86_64 and arm64 — deterministic, not a
   race.

   The fix falls back to `generate_dup_code_for_value`. That emitter writes its
   multi-line shapes straight to the emitter, and a C ternary cannot hold
   statements, so the emission is hoisted into a guarded block —

   ```c
   int  __yo_dc_ok_N  = (d.vtable->__yo_type_id == (uintptr_t)&__yo_typeid_T) ? 1 : 0;
   T    __yo_dc_val_N = (T){0};
   if (__yo_dc_ok_N) {
     __yo_dc_val_N = ((Box*)d.data)->value;
     <structural dup lines>
     __yo_dc_val_N = <dup result>;
   }
   ... (__yo_dc_ok_N) ? (Option(T)){ .tag = SOME, ...= __yo_dc_val_N } : (Option(T)){ .tag = NONE }
   ```

   — and the result ternary tests the hoisted flag. The extraction MUST stay
   behind the type-id check: reading the box's value field when the dyn holds a
   DIFFERENT type reads foreign memory (a smaller box would be read past its
   end). Targets whose type carries no RC keep the old inline expression
   byte-for-byte.

No dup counterpart is needed on the DYN side: `__yo_dup___yo_t<dyn>` increments
the BOX's refcount only, which is correct, and the box owns exactly one copy of
the value.

## Verification

Built stage-1 before (`/tmp/yo-base`) and after (`/tmp/yo-fix3`) with
`yo build --std-path ./std`.

| measurement | before | after |
| --- | --- | --- |
| `leaks -atExit` on the 3-line `AnyError` reproducer | 2 leaks / 80 B | **0 / 0** |
| `leaks -atExit` on the `exn.throw(dyn(...))` reproducer | 2 leaks / 64 B | **0 / 0** |
| `leaks -atExit`, 20 000 throws + 20 000 `dyn(String)` in a loop | 80 000 leaks / 2 880 000 B | **0 / 0** |
| max RSS of that loop | 4 177 920 B | 1 982 464 B |
| payload-free variant (over-drop canary) | 0 | **0** |
| `MallocScribble=1 MallocPreScribble=1` on all three | correct output | correct output (no UAF) |

The downcast half has its own before/after: a probe that downcasts a ref
struct, a value struct, a value enum and a `String` out of a `Dyn` 2 000 times
(`tmp/dc2.yo`) **aborts with rc=133** (macOS malloc double-free) on the build
that had the leak fixed but not the dup, and runs clean with `0 leaks / 0 bytes`
and no `MallocScribble` recycling after it. On Linux the same shape is what
ASan reported as `heap-use-after-free in __yo_decr_rc`.

The emitted C for `box` now carries a dup/drop PAIR, byte-identical in shape to
the monomorphic `mk` that never leaked. The dyn box dispose is no longer empty:

```c
static void __yo_dispose___yo_dyn_box___yo_t4(void* ptr) {
  __yo_dyn_box___yo_t4* box = (__yo_dyn_box___yo_t4*)ptr;
switch ((box->value).tag) {
  case __YO_T5_SOME: {
    __yo_decr_rc((void*)((box->value).data.Some.value));
    break;
  }
  default: break;
}
}
```

## Regression tests

All five were verified RED on the pre-fix stage-1 and GREEN on the post-fix one:

- `tests/dyn.test.yo` — "a value STRUCT boxed into Dyn releases its payload",
  "a value ENUM boxed into Dyn releases its payload", "a Dyn payload that owns
  heap memory releases it". Each observes the release through a `Dispose`
  counter on a module-level `(g_dyn_payload_disposed : i32)` binding, asserted
  at runtime (a `comptime_assert` inside a `test(...)` body verifies nothing —
  `issues/comptime-assert-never-fires-inside-a-function-body.md`).
- `tests/dyn.test.yo` — "downcasting a value payload out of a Dyn dups it",
  which asserts `rc(p.r) == 2` (the downcast copy AND the Dyn's box each hold a
  reference). It reported 1 on the build that had the leak fixed but not the
  dup, which is the exact state ASan crashed on.
- `tests/error.test.yo` — "every AnyError payload thrown in a loop is released"
  (20 throw/catch rounds, each payload released exactly once).
- `tests/rc.test.yo` — "box takes ownership of its argument without retaining an
  extra reference" (`rc(b.*) == 1`; it was 2), and "an own parameter of a
  generic function releases its value exactly once", which covers the wider
  class directly: returned as-is, moved through a local, stored in a generic
  `ref` struct, and never used at all — plus a `String` round trip as an
  over-drop canary (an over-drop would have freed the buffer before the read).

## Not a breaking change

Emission-only; no source-level behaviour changes except that memory is now
released.

## Follow-ups found while measuring (not fixed here)

- The `__yo_dyn_box_*` family (typedef + constructor + dispose + its
  `__yo_dispose_dispatch` type_id) is entirely dead code. Deleting it is a
  separate cleanup.
- `create_specialized_function_inline` (`src/evaluator/calls/helper.yo`) has two
  further parameter RE-binds — the closure-param one and the folded-const one —
  that also hardcode `is_owning_the_rc_value : false` and would SHADOW the
  corrected `check_if_function_parameter_matches_argument` binding. They are
  deliberately left alone: no reproducer reaches them (an `own` parameter that
  is a closure, or whose argument folded to a compile-time value), and a
  folded-const parameter may have no runtime C declaration at all, so
  scheduling a drop for it could emit `___drop` on an undeclared identifier.
  Fix them behind a failing case, not speculatively.
- A `ResumableException` handler written as a BARE `err -> return(v)` (no
  braces) is emitted as an `abort()` stub and kills the process the first time
  it runs — reproduces identically on the pre-fix compiler, so it is unrelated
  to this fix. Filed as
  `issues/fixed/resumable-exception-bare-return-handler-body-aborts.md`.
