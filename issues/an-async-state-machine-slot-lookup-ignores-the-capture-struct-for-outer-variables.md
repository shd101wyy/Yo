# An async state machine's slot lookup ignores the capture struct for an outer variable

**Severity:** S2 (latent; no known program reaches it). If it is reached, a
read goes to a zeroed frame slot instead of the captured value, the same
failure class as
`issues/fixed/an-awaiting-io-async-body-captures-a-local-alias-without-retaining-it.md`
(an empty `String`, or a NULL dereference).

## The defect

`sm_slot_of_variable` (`src/codegen/async/state_machine_naming.yo`) returns
`sm->var_<id>` for every variable, including an entry whose kind is
`CapturedVariableKind.Outer`. An outer variable's storage is the capture
struct, `sm->__capture.<name>`, so for such an entry the returned slot names a
field nothing writes.

Found by the review of #1218. The A/B emission diff of that PR shows that no
current caller passes an `.Outer` entry here: every capture read takes the
capture-struct path before this function is reached. That is why the defect is
latent.

## Fix

Return `__capture.<label>` for an `.Outer` entry, and add a test that reaches
the function with one (a body reading a captured variable through the path
`sm_slot_of_variable` serves). The test must fail before the fix.
