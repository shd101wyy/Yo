# The `io.async` capture re-kind pass matches captures to struct labels by name

**Severity:** S2 (latent; no known program reaches it). A body local whose
name equals a captured variable's name could be re-kinded `.Outer`, after which
its reads and writes would go to the capture struct instead of its own slot.

## The defect

The re-kind pass in `src/codegen/exprs/async.yo` marks a suspension variable
`.Outer` when its name matches a label of the closure's capture struct
(`vars.insert(f.label, … CapturedVariableKind.Outer)`). Names are not
identities: Yo forbids shadowing, but separate bodies (an `io.async` inside a
function whose own body declares a local with a captured variable's name in a
sibling scope) can still put two bindings with one name in front of the pass.

Found by the review of #1218, which kept the name match and only added the
alias-owner rule. Nothing in the suite or `src/` reaches it.

## Fix

Match by the binding's identity (its declaration site, `decl_site`, which the
parameter path already uses, `async.yo` near the `param_sites` check) instead
of its name. Add a test that declares a body local with a captured variable's
name in a sibling scope and checks both values after an `await`, failing before
the fix.
