# Sibling match arms binding the same PATTERN name: the store went to the wrong state-machine slot

**Status: FIXED** 2026-08-09 in BOTH compilers
(`src/codegen/async/state-code-gen.ts`, `src/codegen/exprs/other-fn-call.ts`;
`yo-self/codegen/async/state_code_gen.yo`), with a regression test
(`tests/async_await.test.yo`, "Test same-named pattern bindings in sibling
match arms passed to a capturing future").

This was the `yo build run` SIGSEGV — the last non-PASS case in the CLI
differential (`tests/cli-cases/build-run`, self rc=139).

Reproducer:
[`repros/async-sibling-arm-match-bindings.yo`](repros/async-sibling-arm-match-bindings.yo)

```rust
match(
  kind,
  .A => {
    match(lookup(…), .None => (), .Some(artifact) => {
      d := io.await(describe(artifact, io), io);
      out = d;
    });
  },
  .B => {
    match(lookup(…), .None => (), .Some(artifact) => {   // same name, sibling arm
      d := io.await(describe(artifact, io), io);          // SIGSEGV here
      out = d;
    });
  }
);
```

`describe` is an `fn` whose body is an `io.async` block capturing its
parameter — the shape of `run_executable` in `yo-self/build_runner.yo`, whose
`execute_node` caller binds `artifact` in BOTH its `.Artifact` and `.Run`
arms.

## Root cause

Same-named `:=` locals in sibling arms were fixed earlier
(`issues/fixed/async-sibling-arm-same-named-locals.md`); PATTERN bindings
store through a different path. Each binding correctly gets its own state
machine field, but `generateMatchWithAwait` resolved the field for the
binding STORE by scanning ALL state machine variables for the first name
match:

```ts
for (const [id, varInfo] of functionContext.stateMachineVariables) {
  if (varInfo.name === rawVarName) {
    varId = id;
    break;
  } // first hit wins
}
```

The `.B` arm's store landed in the `.A` arm's field, while the argument READ
(id-resolved through `generateAtom`) used the `.B` arm's own field —
calloc-zeroed, NULL for a ref type:

```c
sm->var_…_artifact_1 = _temp.data.Some.value;      // after the fix
sm->var_…_artifact   = _temp.data.Some.value;      // BEFORE: the .A slot
… describe(sm->var_…_artifact_1, …)                // reads the .B slot → NULL
```

The callee captured NULL and the program SIGSEGVed on the future's first poll
(`ldr` of the enum tag off address `0x60` — a field offset from NULL).

Three sibling sites shared the defect:

1. `state-code-gen.ts` — enum destructuring store (the crash above).
2. `state-code-gen.ts` — nullable-pointer match binding store (same scan).
3. `other-fn-call.ts` `resolveVarNameInContext` — the effect-escape cleanup
   (`if (__yo_effect_escaped) { drop args }`) resolved each RC argument's
   storage by name, so an escape in the `.B` arm dropped the `.A` slot. With
   same-named bindings of DIFFERENT types, that runs the wrong type's drop
   code on a live value.

yo-self had faithfully ported all of it (`_find_sm_var_id_by_name`, iterating
a HashMap — so "first hit" wasn't even deterministic).

## Fix

Resolve the binding by its OWN identity first — the pattern atom's env
(`getVariablesFromEnv(bindingExpr.$.env, name)`, last entry), the same idiom
`match.ts` and `atom.ts` already use:

- If the resolved id IS a state machine variable → store to `sm->var_<id>`.
- If it resolves but is NOT one → it's a genuine segment-local; do NOT fall
  through to the name scan (that would hit a sibling's field again).
- Only when the atom carries no env metadata does the name scan remain, as a
  fallback.

TS: `resolvePatternBindingStateMachineField` (state-code-gen.ts), used by both
match paths; `resolveVarNameInContext` gained an optional `varExpr` param,
passed at the three escape-cleanup sites.
yo-self: `_resolve_pattern_binding_sm_field` (state_code_gen.yo), same two
sites. yo-self's `_resolve_var_name_in_context` counterpart is a stub
(returns the name unchanged — separately documented), so site 3 has no
yo-self change.

## Worth remembering

This is the fourth member of the sibling-arm cluster (`:=` locals, struct-
literal args, awaitless-arm reassignment, pattern bindings). **Any name-based
lookup over `stateMachineVariables` is wrong whenever two declarations share
a name** — resolve through the expression's env to its variable id first, and
treat "resolved but not in the state machine" as a local, never as license to
name-scan.
