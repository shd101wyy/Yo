# Capture-mode state-machine argument rendering: the still-open cluster

**Status: OPEN** (split 2026-09-09 out of
`issues/fixed/async-closure-value-struct-param-emits-invalid-c-cast.md`,
whose PRIMARY bug — the illegal aggregate call-arg cast — is fixed; these
follow-up findings were recorded during the same V2 bisecting session and
remain unreproduced-and-unfixed).

## Findings

1. **Missing-name soft-fallbacks cascade.** An `io.async` closure whose
   body references a name not in scope (e.g. `IoExn` without
   `import("std/error")`, or `String`/`eprintln` without the std/string +
   std/fmt opens — reconfirmed 2026-09-09) silently degrades the await
   call's recorded argument info; the result is either the
   "closure body never fully evaluated" ICE at codegen or (V2-era) an
   invalid `(T)(slot)` C cast. The def-time trial swallows the not-found
   error. Desired behavior: a closure-body name miss should surface as a
   hard-swallow diagnostic at CHECK time (the ICE only fires at compile).

2. **`.io`/`.exn` member projection is position-dependent.** In plain
   segments, `e.io` args render `slot.io`; in cond-branch arms and in
   capture-mode SMs (a closure holding a ref-typed local across a
   suspension) the member access can be dropped and the whole bundle slot
   cast to the param type. A bundle-typed parameter (`bundle : IoExn`,
   invoked as `bundle.io.async(...)`) renders as a same-type slot
   passthrough and is the only arm-safe shape found.

3. **ASan: heap-use-after-free on resume.** A capture-mode SM with a
   ref-struct capture hits a UAF in `__yo_incr_rc` inside the generated
   `<sm>_resume` — the capture is dropped at suspension and re-incremented
   on resume (ASan backtrace captured in the original issue's session).

## Reproducer notes

All three were observed with the pre-sync V2 `src/verifier/driver.yo`
(async shape, since rewritten synchronously). The exact C-level
manifestations may have shifted since (2026-09-09 calibration: clang
ACCEPTS same-type struct casts — `(S)(s_of_type_S)` compiles — and
REJECTS cross-type ones with `used type 'struct T' where arithmetic or
pointer type is required`; the fixed cast bug was the cross-type case).
Reproducing these needs a dedicated probe in the capture-mode shape: an
`io.async` closure holding a ref-struct local across an await, run under
`--sanitize address`.
