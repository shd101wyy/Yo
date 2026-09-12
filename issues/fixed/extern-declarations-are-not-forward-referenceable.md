# `extern("Yo", …)` declarations are not forward-referenceable, and a miss inside `dyn(…)` is swallowed or misreported

**Status:** FIXED 2026-09-12 (`p1/yo-toml-manifest`), both faces.
(1) `src/evaluator/context.yo`: an `extern(...)` statement is a pending
definition of the lazy top-level walk — `classify_pending_def` records it
with `members` = every `label : type` it declares, `_find_def_by_name`
matches a miss on any member, and the resolution returns the module frame's
binding of the requested member (`_def_variable_for`); forcing evaluates the
whole block once and the walk skips it at its own position like any forced
`::` definition. (2) `src/evaluator/values/dyn.yo`: the payload of `dyn(...)`
is evaluated through `evaluate_expression_raw(…, exn)` instead of the
exception-free `evaluate_expression`, whose wrapper SWALLOWS a throw — the
E0401 now reaches the definition (and the "does not implement Error"
message against a stand-in type is gone with it). Gates: the two reproducers
below (`yo check` now passes `extern-forward-ref-not-found.yo` and reports E0401
for `extern-forward-ref-inside-dyn-swallowed.yo`'s payload when the extern is
missing), `tests/extern_unsafe_wrap.test.yo` "definition order: a function may
call an extern member declared below it" (red-first: E0401), cli-case
`check-dyn-unresolved-payload` (`yo check` rc=1 + the E0401; the pre-fix
compiler passed the file), `check ./src` 271/271 and `check ./std` 175/175
with the fixed compiler (nothing in the tree relied on the swallow), and the
compiler's own emission is byte-identical before and after (order-correct
code evaluates exactly as before). Seed gate: the released seed lacks (1), so
`src/` and `std/` still declare an `extern(...)` block ABOVE its first use
(`src/manifest.yo` does, with a comment) until SEED_VERSION carries this.
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

## Fix direction (as implemented)

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
