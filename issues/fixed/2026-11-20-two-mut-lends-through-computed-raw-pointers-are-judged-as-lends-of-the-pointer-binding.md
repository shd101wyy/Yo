# Two `&mut` lends through computed raw pointers are judged as lends of the pointer binding

**Severity:** S2. `two(&mut base.add(0).*, &mut base.add(1).*)` inside `unsafe` is rejected with E0910 ("an earlier argument of the same call lends `base`"). Rust accepts the same call, `f(&mut *p.add(0), &mut *p.add(1))`. A valid program is wrongly rejected, and the workaround is to bind each pointer first.

**Status: FIXED** on `v0280/clusters`, in the rebase onto the kebab rename.

## How it was found

The audit-A17 change (`check_tuple_element_lends`, `src/evaluator/calls/function.yo`) runs decision 28's argument
exclusivity over a tuple literal's elements, through the same place walk the call path uses. On the rebased tree,
`scripts/origins-corpus.sh today` failed the positive N2 row `tests/origins/corpus/get2-mut-pair.yo`:
`(&mut base.add(i).*, &mut base.add(j).*)` became E0910. The call form was already rejected on develop. The tuple
form surfaced it only because tuples had not been checked before.

## Root cause

`_lent_place_of` walks a lent place back to its root binding. At `base.add(i).*` it took the raw-pointer step (`*`,
`deref_operand_is_raw_pointer`) and continued into the operand `base.add(i)`. That operand is a method call, not a
field path, so the walk took the index arm (`xs(i)` overlaps its receiver): it cleared the path and continued into
the callee `base.add`. The result was the place `base` with the path `[add]`. Both elements then named that one
place.

## Fix

At a raw-pointer `*` whose operand is a call result (any call that is not a field access), `_lent_place_of` returns
`None`. A computed raw pointer's pointee is unchecked unsafe storage, not a place of any binding. A deref of a
pointer held in a binding or a field (`p.*.a`, `s.p.*`) still walks on, as before.

## Test

`tests/origins/unsound/a17-tuple-raw-computed-pointer-mut-lends-pos.yo` (`// expect: accept`, run by
`scripts/origins-unsound.sh`) checks the tuple form and the call form, and runs them under ASan. Before the fix, both
were E0910 on the branch binary, and the call form was E0910 on develop too. The corpus row `get2-mut-pair` is back
to `accept`.
