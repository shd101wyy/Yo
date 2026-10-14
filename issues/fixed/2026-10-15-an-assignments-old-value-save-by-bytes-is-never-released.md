# An assignment's by-bytes old-value save is never released on an early exit

**Severity:** S1. Generated code leaks without bound. Every explicit `return` or `exn` escape that leaves a scope after an assignment of an RC-bearing value leaked the overwritten value. On develop this raised `check src/main.yo` max RSS 2.5× (973,268 kB baseline → 2,429,508 kB) and the self-compile peak +29% (3,317,216 kB → 4,283,636 kB), which blocked the v0.2.63 release.

**Status:** FIXED 2026-10-15. This regression came from #1365 (b88518aa0).

## Symptom

Both memory ratchets in battery run 38577442718 (960a3904c) failed. The previous run of those jobs, 38559516989 (57e5c98c3), passed them. Wall time did not move (`check src/main.yo` 4:32 → 4:37), so the compiler did the same work and freed less.

A minimal reproducer, run under `leaks --atExit`:

```yo ignore
early :: (fn(n : usize) -> usize)({
  x := rc(String.from("first"));
  x = rc(String.from("second"));
  if(n < usize(1000), {
    return(x.*.len());
  });
  n
});
// called 100 times: seed v0.2.62 codegen 0 leaks; codegen at 23787451b 300 leaks (9,600 bytes)
```

## Root cause

- #1365 changed every assignment's old-value save in `generate_assignment` (`src/codegen/exprs/assignment.yo`) from a typed load, `T temp = lhs;`, to a byte copy, `T temp; memcpy(&temp, &(lhs), sizeof(temp));`. The aim was to stop loading an uninitialized `bool` or enum slot (`issues/fixed/an-assignments-old-value-save-reads-uninitialized-memory-for-pod-types.md`).
- The emitter's block-scope stack learns declarations from `_emitter_record_scope_decl` (`src/emitter.yo`), a line scan that records only `<type> <name> = …`. The new line has no ` = `, so the save temp never entered the stack.
- The escape gate keeps a pending drop only when its target is on that stack. Every early-exit drop list (`return`, `exn` escapes) therefore dropped the save temp's release without a word. The normal scope-end release was unaffected, which is why functional tests stayed green.
- `get_variable_type_string` still recorded the name in `declared_c_var_names`, so only the scope stack was missing it.
- Before #1365, only `consume(p.* = v)` used the byte copy (#976). That save is never released anyway, because the evaluator marks a consumed assignment's result temp as consumed. Making the copy universal is what exposed the gap.

It is the same class as `issues/fixed/2026-10-14-a-block-result-that-is-not-moved-is-never-released.md`, fixed in the same PR: a declaration that the line scan cannot see.

Measured on the CI stage-2 C (`bootstrap-stage2` artifacts of the two runs):

- `__yo_decr_rc` call sites fell from 478,753 to 456,491 (−22,262). `__yo_incr_rc` stayed flat (27,296 → 27,351).
- The drops lost were all on early-exit paths. For example, in the evaluator's initialization-assignment function the old-value temp of `ctx.local_variant_hint = .None` was released at 162 sites before and at 1 site (scope end) after.

## Fix

`generate_assignment` puts the save temp on the block-scope stack (`em.mark_declared_in_scope`) right after emitting the byte copy. This is exactly what the line scan did for the typed form, so the early-exit drops come back while the save stays a defined byte copy. The state-machine save forms still spell `= `, so they need nothing.

## Verification

- `tests/shadowed_binding_early_return_drop.test.yo` adds two tests: "an early return after an assignment releases the overwritten value once" and "an early return after a field store releases the field's old value once". With a `Drop` counter they cover a local reassignment and a field store through a `ref`, each followed by a taken `return`. Both fail on a compiler built from 23787451b and pass on seed v0.2.62 and with the fix. The normal-path counts are the over-release canaries.
- Memory ratchet numbers before and after are in the PR.
