# Order-dependent generic-slot stranding: `ptr: Expected T, Got *(u8)` at prelude:6801

**Status:** OPEN (mechanism measured 2026-09-20; the fix below was
implemented and REVERTED after A/B — see the end). Found 2026-09-20 while
characterizing the doc_stability warm bug
(issues/warm-test-batches-doc-stability-genericimplentry.md) — the two are
siblings of the same shared-signature-slot disease.

## Symptom

An in-process test batch compiling a file that exercises `str` slicing dies:

```
error[E0605]: Type mismatch for parameter "ptr":
- Expected: T
- Got     : *(u8)
     --> std/prelude.yo:6801:18
6801 |     __yo_ptr_add(self, count)
```

`__yo_ptr_add : (fn(generic(T : Type), ptr : T, offset : usize) -> T)` — the
call's `T := *(u8)` binding was WRITTEN (a `[bind-T]` probe event shows
`val=*(u8) slot_lvl=1 top=1 inplace=true` immediately before the error) yet
Step 7's `evaluate_function_parameter_type_again` → `_resolve_some_types_deep`
→ `get_value_of_some_type_from_env` read the slot back ABSTRACT.

**The failure is order-dependent per binary**: identical source, identical
invocation, different builds — some die, some don't. Adding a debug env var
(`YO_DEBUG_BIND=T`) flips a failing build to passing. The trigger is the
id/hash-iteration order of the evaluator's registries (timestamp-minted
`yo_id_*` ids key hashed tables), which reshuffles evaluation order.

## Mechanism (measured)

1. Step 6 writes the signature slot's self-marker (`T := SomeT(sig)`) into
   the callee env, then the argument synthesis binds the concrete
   (`T := *(u8)`).
2. `_bind_some_type`'s top-frame path updated the marker variable IN PLACE —
   CONSUMING the marker, the only ownership evidence the reader has.
3. The later read: the (frame_level, name) fast path misses (the shared
   signature slot's `frame_level` is its deep minting level, not the callee
   env's layout), the chain fallback found the concrete as the LAST `T`
   binding, but `_was_self_bound` could no longer find the marker and
   `_def_frame_confirms_binding` could not confirm against a drifted frame
   level → refused → the param type stayed abstract → E0605.

In TS this cannot happen: envs are per-call persistent chains, so
`updateExistingVariable` creates a new chain link while the old marker link
survives on the chain the reader walks.

## Fix (two parts)

- **Marker preservation** (`_bind_some_type`, evaluator/types/synthesizer.yo):
  an in-place update of our OWN self-marker with a concrete now
  shadow-appends instead, keeping the marker variable alive for ownership
  checks. Reads still see innermost-wins.
- **Ownership pairing** (`_owned_concrete`, types/env_lookup.yo): the chain
  fallback pairs each concrete `T`-binding with the nearest SomeT marker
  recorded before it; the concrete belongs to that marker's slot id. A
  sibling lineage's concrete is never attributed to this slot.

## Repro (historical, pre-fix)

```
tests/internal-bisect/ = {doc_render_markdown.test.yo, doc_stability.test.yo}
YO_TEST_IN_PROCESS=1 yo test ./tests/internal-bisect --parallel 1
```

Passes or fails depending on the binary's id luck (deterministic per binary;
~coin-flip per build). The `[bind-T]`/`[chres-refuse]` probes
(YO_DEBUG_BIND / YO_DEBUG_SOME) name the stranding bind/read when it fires.

## Fix attempt 2026-09-20 — implemented, measured, REVERTED

Marker preservation (shadow-append over our own self-marker) plus ownership
pairing in `_do_chain_resolve` were cold-green on the light gates but broke
tests/arc.test.yo at C compile (the closure `io` param's `Io` trait type
split into two identical C structs). A/B: pairing-only still failed; both
off passed 15/15. The pairing's invariant ("every concrete is preceded by
its own marker") does not hold — marker-less concrete appends exist — so it
misattributes. Both reverted; the record lives in
issues/warm-test-batches-doc-stability-genericimplentry.md's 2026-09-20
section. Reviving this fix requires enforcing the marker-before-concrete
invariant at every concrete append site first.
