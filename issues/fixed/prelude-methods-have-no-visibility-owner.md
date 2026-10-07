# Prelude-declared methods carry no visibility owner — a `_`-prefixed method there is public everywhere

**Severity:** S3 — the member-visibility guarantee is silently absent for the one module every file imports; no underscore method exists in the prelude today, so nothing is exploitable until one is added

**Found**: 2026-10-01, during the safe-mode handover §3.2 audit (safe-code pointer-free API sweep): a `MaybeUninit._assume_init_plain` experiment compiled from a pragma-less user file although the same shape on `HashMap` (`_owned`), on a user module's struct, enum-generic, and newtype types — and on `std/string`'s `String` — is rejected with E0405. **Status**: FIXED 2026-10-04 — see "Fixed" below.

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

## Fixed

Root cause confirmed as triaged: `mm_load_prelude_file` evaluates the prelude
outside the module loader, so `_registration_owner` stayed `""` for its whole
evaluation and every `MethodEntry` its impls register was unowned — which
`private_member_blocked`'s `.None` arm never blocks. Fixed by stamping the
prelude's own key around its evaluation (the `register_loading`/
`unregister_loading` discipline done by hand, in
`src/module_manager.yo:mm_load_prelude_file`): `set_registration_owner("${std_path}/prelude.yo")`
before the begin-expr evaluation, restored after, with
`mark_owner_always_visible` of the same key applied alongside so prelude impls
stay resolvable from every module without an import edge — the mark moved from
`mm_preload_prelude` into `mm_load_prelude_file`, because the single-file
self-bootstrap path in `mm_load_file` loads the prelude without going through
`mm_preload_prelude` and a stamped-but-unmarked prelude would have made every
prelude method invisible. The key is deliberately NOT a `file://` loading key,
so `mm_invalidate_document`'s per-document registry purges (which compare
loading keys) can never drop prelude registrations — the cached prelude is
never re-evaluated, matching "editing std/prelude.yo still needs a server
restart". The one owner-`""` consumer moved in lockstep: the prelude's
minted-value collection (`type_trait_method_values_owned_by(String.new())` →
the stamped key). Field visibility was never affected — it goes through
`register_type_decl_module`, which is keyed on the declaration token's module
path, not the registration owner.

Test: `tests/member_visibility.test.yo`'s "a prelude-declared private method
is not callable from another directory", backed by the test-support member
`MaybeUninit._probe` added to `std/prelude.yo` (the prelude had no `_` impl
method, so one had to exist for the rule to be gateable). Verified RED first —
`comptime_expect_error(m._probe(), "is private")` raised its own "expected an
error" complaint with the unfixed binary (the repro file also compiled, ran
and printed `_probe() == 7`) — and GREEN after the fix.

One follow-up filed while landing this: the STATIC spelling
`MaybeUninit(i64)._probe(m)` still passes — but an A/B against a non-prelude
module shows that is not a prelude defect: the static form of a generic impl's
private method is not E0405-gated for ANY module (instance form is), see
`issues/static-form-of-a-generic-impl-private-method-is-not-e0405-gated.md`.

Fixed 2026-10-04 on branch `s3/batch-2-fixes`.
