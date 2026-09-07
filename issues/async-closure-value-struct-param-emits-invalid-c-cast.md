# An async closure capturing a by-value struct parameter emits an invalid C cast

**Status: OPEN** (surfaced 2026-09-07 by Phase V2 of
`plans/backlog/FORMAL_VERIFICATION.md` — `src/verifier/driver.yo`'s async
functions took a `VerifyRunConfig` value-struct parameter).

## Error

`yo check` passes (the def-time trial swallows it — the ICE guard for
"never fully evaluated" does not fire because the closure body itself is
fine; only the CAPTURE is malformed). The failure surfaces at the C
compile step of `yo build`:

```
yo.c:2555870:160: error: used type '__yo_t50' (aka 'struct __yo_t50_struct')
      where arithmetic or pointer type is required
```

The generated resume body reads the captured parameter as

```c
(_state_t*)yo_id_21303((__yo_t36*)(...), (__yo_t50)(sm->__yo_param_0), ...);
```

— a cast to the struct's own C type, which is not a legal scalar/pointer
cast. The `sm->__yo_param_<i>` field is ALREADY declared with the
parameter's C type (`ClosureParamSlot`/`SyncParamSlot` carry `c_type`), so
the cast is redundant for every type and invalid for by-value structs.

## Reproducer

```rust
open(import("std/string"));
{ assert } :: import("std/assert");
C :: struct(a : bool);
probe :: (
  fn(c : C, io : Io) -> Impl(Future(unit, IoExn))
)(
  io.async((e : IoExn) => {
    if(c.a, {
      eprintln(String.from("a"));
    });
    ()
  })
);
export(probe);
```

`yo check` accepts it; `yo compile` dies in the C compile (or emits the
invalid cast into `--emit-c` output). Making `C` a `ref(struct(...))`
compiles fine — the cast is harmless for pointer types.

## Root cause analysis

The state-machine emitter renders a captured closure parameter's reads as
`(T)(sm->__yo_param_<i>)`. For reference/pointer types this is a no-op
cast; for by-value struct types C rejects it outright. The parameter slot
fields are typed (`__yo_t50 __yo_param_0;`), so the read should be a bare
`sm->__yo_param_<i>` — or, where a `void*` slot is genuinely used, an
explicit dereference/memcpy rather than a cast.

## Fix direction

Find the variable-read remapping that wraps `__yo_param_<i>` slot reads in
a cast (`src/codegen/exprs/async.yo` builds the slots;
`src/codegen/async/state_machine.yo`'s variable context installs the
remapping) and emit the bare field access — the field already carries the
right type.

## Follow-up findings (2026-09-07, deeper bisecting)

The invalid cast is one face of a broader **capture-mode state-machine
argument-rendering** defect cluster:

1. **Missing-name soft-fallbacks cascade.** An `io.async` closure whose
   body references a name not in scope (e.g. `IoExn` without
   `import("std/error")`) silently degrades the await call's recorded arg
   info; the result is either the "closure body never fully evaluated"
   ICE at codegen or the invalid `(T)(slot)` cast above. The def-time
   trial swallows the not-found error (repro: any tmp file with
   `io.async((e : IoExn) => e.io.await(write_string(p, s, e.io), e))` and
   no std/error import).
2. **`.io`/`.exn` member projection is position-dependent.** In plain
   segments, `e.io` args render `slot.io` (healthy sites across src/);
   in cond-branch arms and in capture-mode SMs (a closure holding a
   ref-typed local like `q : VcQuery` across a suspension) the member
   access is dropped and the whole bundle slot is cast to the param type.
   A bundle-typed parameter (`bundle : IoExn`, invoked as
   `bundle.io.async(...)`) renders as a same-type slot passthrough and is
   the only arm-safe shape found.
3. **ASan: heap-use-after-free on resume.** A capture-mode SM with a
   ref-struct capture (the pre-sync V2 driver) hits a UAF in
   `__yo_incr_rc` inside the generated `<sm>_resume` — the capture is
   dropped at suspension and re-incremented on resume
   (`issues/async-closure-value-struct-param-emits-invalid-c-cast.md`,
   ASan backtrace captured).

The V2 verifier sidestepped the whole cluster by going synchronous (the
`module_manager.yo` comptime-file-IO idiom: libc open/read/fopen +
`system(3)` for the solver spawn); its only async function is the one-time
Z3 download install, kept in `version_cache.yo`'s proven shape. The
underlying async-backend bugs remain OPEN.

## Notes

- Worked around in V2 by the sync harness (see above); `VerifyRunConfig`
  stayed a value struct after all.
