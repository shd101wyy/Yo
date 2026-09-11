# In an `io.async` body, a local named like a struct FIELD read in the same body gets the field's type in the state machine

**Status:** FIXED 2026-09-11 (`fix/async-nested-while-labels`, stacked on #592).
**Found:** 2026-09-11, on branch `p1/transitive-path-deps` (`src/build_runner.yo`,
`_resolve_artifact_import_roots`), compiling with the v0.2.30 seed.
**Severity:** medium — `check` is clean; the C compiler rejects the emission,
so it is loud, but the message points at generated temporaries and nothing in
the Yo source looks wrong.

## Symptom

```
yo-p6.c:2739082:26: error: assigning to '__yo_t4' (aka 'struct __yo_t4_struct') from incompatible type '__yo_t0' (aka 'struct __yo_t1_struct')
```

with, in the state-machine struct, `__yo_t4 var_15655077;  // root` — the
local `root : String` declared as `Option(String)`.

## Shape

```rust
DepModuleResolution :: ref(struct(root : Option(String), registry : Option(BuildRegistry)));

_resolve :: (fn(...) -> Impl(Future(unit, IoExn)))(
  io.async((e : IoExn) => {
    while(pending.len() > usize(0), {
      resolution := e.io.await(_dependency_module_root(...), e);   // returns DepModuleResolution
      dep_root_opt := resolution.root;                              // FIELD named `root`, Option(String)
      root := cond(                                                 // LOCAL named `root`, String
        cond_a => ...String...,
        true => match(dep_root_opt, .Some(r) => r, .None => { ...; String.new() })
      );
      seen_roots.push(root.clone());                                // → C: Option(String) passed as String
      ...
    });
  })
);
```

Renaming the FIELD (`root` → `module_root`, `registry` → `dep_registry`) with no
other change makes the emission correct; renaming only the local in the OTHER
async fn of the module did not. So the async emitter's slot typing for `root`
picked up the type of the field access `resolution.root` — the slot appears to
be keyed by NAME (`_find_sm_var_id_by_name` / the field-alias table in
`state_code_gen.yo`), and a `.root` field read registered first.

## Root cause and fix (2026-09-11)

Not the codegen slot table — the EVALUATOR's suspension analysis
(`src/evaluator/shared/suspension_analysis.yo`, `walk_expr_`). Its Atom case
captures every identifier atom that resolves in the atom's environment, with
the atom's ExprInfo TYPE as the captured type. The member atom of a field
access `resolution.root` is such an atom: it resolves BY NAME to the local
`root` (the body's frame already holds it) and its ExprInfo type is the
field's, `Option(String)` — so the local's state-machine slot was declared
with the field's type. The walker now treats a two-argument `.` call whose
member is an identifier as a field access and walks only the object; the
member names a field, never a suspension-crossing value.

**Gate:** `tests/async_await.test.yo` — "a local named like a struct field
read in the same async body keeps its own type";
`issues/repros/async-body-local-shares-its-state-machine-slot-type-with-a-same-named-struct-field.yo`
(C compile error pre-fix, `/dep;/dep;` after).

## Fix direction (as filed)

Key state-machine slots by the binding's variable id (the `var_<id>` the
emitter already mints), never by the source name; a field access must not
create or retype a slot. Gate: the shape above in `tests/async_await.test.yo`
(a struct with a field `x`, a local `x` of a different type in the same async
body, both used after an await).
