# `extern("Yo", …)` declarations are not forward-referenceable, and a miss inside `dyn(…)` is swallowed or misreported

**Status:** OPEN
**Found:** 2026-09-12, writing `src/manifest.yo` (the `yo.toml` manifest): its
`read_file_sync` called `__yo_errno()` and the `extern("Yo", __yo_errno : …)`
block sat BELOW the function, as it does in `std/fs/file.yo`'s style but in
the opposite order to `src/module_manager.yo`.
**Severity:** medium — two faces. (1) `::` definitions are order-independent
since `plans/reference/LAZY_TOPLEVEL_BINDINGS.md` landed, but an `extern(...)`
member is not a `::` binding and is not collected as a pending entry, so a
call above the declaration is `E0401 Variable "__yo_errno" not found`
(`issues/repros/extern-forward-ref-not-found.yo`). That contradicts
`docs/*/DEFINITION_ORDER.md`'s promise for the rest of a module. (2) When
the unresolved call is an ARGUMENT of `dyn(...)` inside a fn body
(`exn.throw(dyn(IoError.from_errno(__yo_errno())))`), the miss is not
reported at all — `yo check` passes the file
(`issues/repros/extern-forward-ref-inside-dyn-swallowed.yo`) — or, in the
larger module, surfaces as the unrelated
`Type fn(T : Type) -> Type does not implement the trait Error required by
dyn(Error + ToString)` pointing at the fn's body open brace. The deferred
def-eval trial swallows the unresolved name; codegen would then emit a
hollow body or fail later with the misleading message.

## Reproducers

```bash
yo check issues/repros/extern-forward-ref-not-found.yo        # E0401 — should pass
yo check issues/repros/extern-forward-ref-inside-dyn-swallowed.yo  # passes — should be E0401, or pass once (1) is fixed
```

Moving the `extern(...)` block above its first use makes both check and
compile (`src/manifest.yo` does that today, with a comment).

## Fix direction

- Collect `extern(...)` (and `c_include(...)`-declared) member names in the
  lazy top-level pre-pass alongside `::` definitions, so a lookup MISS forces
  the declaration the way it forces a pending `::` entry
  (`force_pending`, `src/evaluator/`). The declaration has no body to
  evaluate, so no cycle or two-phase concerns apply.
- Independently, the def-eval swallow: an unresolved VARIABLE inside a
  `dyn(...)` argument must re-raise as the E0401 it is
  (`issues/fixed/def-eval-swallow-reraise-via-flow-violation` is the same
  class for async closures — the flow-violation flag should cover this
  path too), and the "does not implement Error" message must not be produced
  for an argument whose type is unknown because its callee is unresolved.
- Gate: both repros as `tests/` cases (a `yo check` cli-case for the E0401 →
  pass flip; a compile-and-run test for the `dyn` case), plus `check ./src`
  with `src/manifest.yo`'s extern moved back below its use.
