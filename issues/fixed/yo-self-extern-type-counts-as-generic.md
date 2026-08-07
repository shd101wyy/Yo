# yo-self: an EXTERN type counted as generic, so `atomic(ref(struct(…)))` got no constructor

_Found + fixed 2026-07-25. Repro:
`issues/repros/atomic-extern-struct-ctor.yo`._

## Symptom

`s2 test ./tests/sync/*.test.yo` failed to C-compile:

    error: call to undeclared function '__yo_new___yo_t18'
    error: incompatible integer to pointer conversion initializing
           '__yo_t18 *' with an expression of type 'int'

The struct TYPEDEF was emitted correctly —

    struct __yo_t0_struct { // AtomicBool : AtomicBool (atomic reference counted)
      __yo_ref_header_t header;
      atomic_bool _u42_;
    };

— but its `__yo_new_<cName>` constructor was neither declared nor defined,
while non-atomic ref structs in the same file got theirs.

## Diagnosis

A probe emitted as a C comment from the constructor-declaration loop
(`codegen/functions/declarations.yo`) over `context.types`:

    // PROBE entry c_name=__yo_t0  is_ref_struct=true  generic=TRUE   <- AtomicBool
    // PROBE entry c_name=__yo_t10 is_ref_struct=true  generic=TRUE   <- AtomicI32
    // PROBE entry c_name=__yo_t13 is_ref_struct=true  generic=false  <- ctor emitted
    // PROBE entry c_name=__yo_t4  is_ref_struct=true  generic=false  <- ctor emitted

So the guard was right and the type WAS in the table; the loops skipped
these two as "generic structs" because `type_contains_some_type` returned
true for the field type.

`AtomicBool :: atomic(ref(struct((*) : atomic_bool)))`, and `atomic_bool`
is `extern("c", atomic_bool : Type)` (std/libc/stdatomic.yo) — a SomeType
that is nonetheless CONCRETE at codegen time.

TS handles exactly this (`typeContainsSomeType`, src/types/utils.ts:492):

```ts
if (isSomeType(type)) {
  // If it's an extern type, it's concrete at codegen time, so don't count it
  if (type.isExtern) {
    return false;
  }
  ...
```

The yo-self port had the `resolved_concrete` and Impl(Fn)/Impl(Future)
carve-outs but **not the extern one**.

## Fix

Add the extern carve-out to `type_contains_some_type`
(yo-self/types/utils.yo), FIRST in the `cond` to match TS's ordering.

**Representation divergence (documented at the site):** TS carries
`isExtern` on the base `Type` (definitions.ts:46). yo-self's `TypeValue`
is an enum with no such slot on `SomeT`, so extern-ness already lives in
the `g_extern_type_names` side table (`types/guards.yo`), registered by
`evaluator/exprs/extern.yo:269`. The port therefore checks
`is_extern_type_name(name)` — same semantics, yo-self's mechanism.

## Result

`sync/atomic` 15/15, `sync/waitgroup` 14/14, `sync/rwlock` 15/15 — all
matching the TS reference counts exactly. #69: 161 → 164/183.

Still red in that family — and NOT this bug, but do not trust the old
attribution either:

- `sync/once` and `sync/channel` show the SAME `__yo_new___yo_tN`
  undeclared-ctor symptom yet still fail WITH this fix applied, so a
  different type is being skipped. (A minimal `Once.new()` + `is_done()`
  repro now compiles clean, so the residual failure is in the richer part
  of the test — likely the `o.call(closure)` path.) Read their post-fix
  logs before theorising.
- `sync/mutex` is genuinely distinct: a specialized fn emitted with
  `__unknown__Type__` in its name. Note `unknown` is an INTENTIONAL
  signature fallback in BOTH compilers (TS helper.ts:2149), so that is a
  spec-identity/emission problem, not a naming one.

## Audit: are there OTHER missing extern carve-outs? — NO (checked)

TS reads `isExtern` in four places in `src/types/utils.ts`. Checked each
against its yo-self port so nobody repeats this:

| TS site                                    | yo-self                                                                                                                                              | verdict                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| :499 `typeContainsSomeType`                | `types/utils.yo type_contains_some_type`                                                                                                             | **WAS THE BUG — fixed here** |
| :703 `typeContainsSomeTypeForCodegenParam` | `evaluator/trait_checking.yo:1265` — already uses `is_extern_type_name`                                                                              | OK                           |
| :145 `typeContainsRcType`                  | `types/utils.yo _type_contains_rc_inner` — has NO `.SomeT` arm, so a SomeT falls through to `false`, which is what TS's extern early-return produces | OK (equivalent)              |
| :604 `typeContainsUnboundSomeType`         | not ported (unused in yo-self)                                                                                                                       | N/A                          |

So the extern-vs-generic gap existed in exactly ONE place. The port is
otherwise consistent on this axis.
