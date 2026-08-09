# Four async-codegen bugs exposed by wiring `build`/`fetch`/`install`

**Status: FIXED** (2026-08-09), each with a regression test in
`tests/async_await.test.yo`, in BOTH compilers.

## How they were found

`plans/P1_CLI_PARITY.md` §1 predicted this exactly: _"in this codebase 'ported'
can mean 'type-checks and is unreachable', and `check` cannot tell those
apart."_ `build_runner.yo`, `fetch.yo` and `install_command.yo` had been
type-checking cleanly while reachable from no subcommand — so codegen had never
run on them. Dispatching them from `main.yo` put ~2,600 lines of async code in
front of the code generator for the first time and it emitted **17 C errors**.
`check ./yo-self` was green before and after.

## 1. `return(<local>)` from an async body that awaits later — invalid C

```
sm->result = results;      // `results` is not a C identifier in this scope
```

`codegen/exprs/return.ts` used `expr.$.variableName` — the SOURCE name —
verbatim on the async-completion path. When the body has a later await it
becomes a multi-state machine and the local is hoisted to `sm->var_<id>`, so the
bare name refers to nothing. With no later await there is one state, nothing is
hoisted, and the bare name happens to be right; that is why it had never fired.

Fixed by resolving the name through the state-machine variable map
(`resolveVarNameInContext`, now exported from `codegen/exprs/other-fn-call.ts`),
which returns the name unchanged when it really is a C temp.

## 2. Sibling / nested matches with awaits — duplicate `case` values

```
case 0: { … }   case 0: { … }   case 1: { … }   case 1: { … }   case 1: { … }
```

Every `cond`/`match` that awaits under one await point shares ONE
`asyncCondBranchInfo` entry and therefore one resume `switch`, and each numbered
its own arms from 0. Two matches under the same await point — an outer match
whose arms each contain an inner match, exactly `execute_node`'s shape — emitted
colliding labels and C rejected the whole function.

Fixed by `allocCondBranchCodes` in `codegen/async/state-code-gen.ts`: a
per-function counter hands each awaiting arm a code unique within the function,
used by both the writer (`sm->cond_branch_N = <code>`) and the reader
(`case <code>:`). Distinct matches become distinguishable at runtime too, not
merely C-legal.

## 3. `match` on a payload-free enum inside an async body — invalid C

```
switch (sm->__capture.k.tag)   // member reference base type … is not a structure
```

A payload-free enum lowers to a plain C enum ("optimized as simple enum") with
no `tag` member. `codegen/exprs/match.ts` has always branched on
`canOptimizeAsSimpleEnum`; the async match generator in
`codegen/async/state-code-gen.ts` did not, and emitted `.tag` unconditionally.

Fixed by giving the async generator the same branch.

## 4. An awaited result BOUND in two match arms — SILENT WRONG ANSWER

The only one of the four that compiled and ran. It just answered `false`/`0`.

```rust
match(k,
  .A => { match(opt, .None => (), .Some(_) => { a := e.io.await(f(), e.io); … }); },
  .B => { match(opt, .None => (), .Some(_) => { b := e.io.await(f(), e.io); … }); },
  .C => ());
```

Measured on the reproducer: `A=true`, `B=false`, `C=true` where all three must
be `true`. In the emitted C, `sm->var_…_a = sm->await_result_0;` appears once and
`sm->var_…_b` is never assigned at all.

Several arms collapse onto ONE await point — only one arm can run, so a single
suspension state suffices, and the arm is selected on resume by
`sm->cond_branch_N`. That much is by design. But the copy from the await result
to the arm's binding was emitted ONCE, before the branch switch, driven by
`prevAwait.targetVariableId` — a property of the AWAIT POINT, which can only
name one arm's variable.

Fixed by recording the binding per BRANCH (`awaitTargetVariableId`, filled by
`findBranchAwaitTargetVariableId`, which mirrors `extractTargetVariableId`'s
"the await is the direct RHS of a `:=`" contract and does not descend into a
nested `io.async`) and emitting `sm->var_<branch target> = sm->await_result_N;`
at the top of that branch's `case`. The arm already covered by the pre-switch
copy is skipped so it is not written twice.

## Result

17 C errors → 4. The remaining 4 are one class:
`redefinition of 'p'` / `'sub_path'` / `'it'` — a match-arm destructuring binding
declared once by the destructuring and again by the state-machine "load" of a
same-named hoisted local. `localShadowedVariables` in
`codegen/functions/context.ts` is the mechanism designed for it and is wired
only into the nullable-pointer match path; the tagged-union path never registers
its bindings. Tracked in
[`async-match-binding-redeclared-in-state-machine.md`](async-match-binding-redeclared-in-state-machine.md).
