# Prelude-declared methods carry no visibility owner — a `_`-prefixed method there is public everywhere

**Severity:** S3 — the member-visibility guarantee is silently absent for the one module every file imports; no underscore method exists in the prelude today, so nothing is exploitable until one is added

**Found**: 2026-10-01, during the safe-mode handover §3.2 audit (safe-code pointer-free API sweep): a `MaybeUninit._assume_init_plain` experiment compiled from a pragma-less user file although the same shape on `HashMap` (`_owned`), on a user module's struct, enum-generic, and newtype types — and on `std/string`'s `String` — is rejected with E0405. **Status**: OPEN.

## Symptom

`MethodEntry.owner` is stamped by `register_type_trait_method` from
`registration_owner()` (`src/evaluator/values/type_trait_methods.yo:183-186`),
which the module loader sets while a module evaluates. The prelude is evaluated
outside that window, so every method its impls register carries `owner == ""` —
and the gate's own doc says `""` = unknown, never enforced
(`src/evaluator/calls/function.yo:275` falls to `private_member_blocked`'s
`.None`/empty case). Result, measured with v0.2.48:

1. Add any `_`-prefixed method to a prelude impl, e.g.
   `impl(generic(BaseType : Type), MaybeUninit(BaseType), _probe : (fn(self : Self) -> i32)(i32(7)));`
2. From a pragma-less user file: `m := MaybeUninit(i64).new(); m._probe();`

Expected: `error[E0405]: Method "_probe" of MaybeUninit(i64) is private to its
declaring module` — that is what every NON-prelude module produces for the same
shape (verified: `HashMap._owned`, a user-module newtype, a user-module generic
struct, and a temp `String._probe` in `std/string` are all blocked).

Measured: the call compiles and runs.

Controlled variables ruled out by probes: the receiver form (`self` vs
`own(self)`), generic vs inherent impl, newtype vs struct vs ref(struct). The
declaring module being `std/prelude.yo` is the trigger.

## Root cause

The prelude loads through the evaluator's own init path, not the demand loader,
so `set_registration_owner` never runs for it. `_registration_owner` stays
empty and every prelude method entry is registered unowned.

## Why this matters

`plans/reference/MEMBER_VISIBILITY.md` (LANDED, PR #716) states the rule
without a prelude carve-out: a `_`-prefixed impl method is private to its
declaring module. The prelude is the module where underscore helpers are most
tempting (the `__yo_*` wrapper layer); a contributor adding one today gets a
silently public method. It is also the module whose privacy the safe-mode
audit's reasoning leans on ("private fields/methods are only reachable
in-module").

## Fix

Stamp the registration owner during prelude evaluation — either set
`_registration_owner` to the prelude's `file://` path around its begin-expr
evaluation, or make `register_type_trait_method` fall back to the impl's
decl module (as generic-impl candidates already do) instead of `""` for
prelude-registered entries. Then add the failing-test-first case to
`tests/member_visibility.test.yo`: a prelude type with a `_` method, called
from the test file, expecting E0405.

## Reproducer

Dev-only (needs a prelude edit): the two steps above, or see the transcript of
`issues/fixed/safe-code-reads-uninitialized-memory-through-maybeuninit-assume-init.md`
where a `_assume_init_plain` backdoor was caught and removed during the audit
precisely because this gap kept it reachable.
