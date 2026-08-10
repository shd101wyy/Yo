# Same-named locals in sibling branches of an async body are conflated

**Status: FIXED** 2026-08-09, in BOTH compilers, with two regression tests
(`tests/async_await.test.yo`: "Test same-named locals in sibling match arms of an
async body" and "… used as struct-literal arguments"). Found the same day as the
ROOT of most of the last 4 C errors that kept `build`/`fetch`/`install` from being
dispatched in `yo-self/main.yo`. The five-bug async-branch cluster before it is
fixed ([write-up](async-await-in-nested-match-arms.md)).

Two locals with the SAME NAME, defined in two different branches of one
`io.async` body, are SSA-renamed by the evaluator (`label` and `label_1`) but
the state machine does not keep them apart. Depending on how the second one is
used this surfaces three ways — **one of them silent**.

## A. SILENT WRONG ANSWER — the second branch reads an empty value

Reproducer: [`repros/async-sibling-arm-same-named-locals.yo`](repros/async-sibling-arm-same-named-locals.yo)

```rust
match(
  k,
  .Exe => {
    label := String.from("exe");
    description = `compile ${label} ${name}`;
    e.io.await(yield(e.io), e.io);
  },
  .Lib => {
    label := String.from("lib");           // <- same name, different arm
    description = `compile ${label} ${name}`;
    e.io.await(yield(e.io), e.io);
  }
);
return(description);
```

```
$ ./yo-cli compile … && ./a.out      # BEFORE the fix
compile exe thing
compile  thing        <-- `label` is EMPTY in the second arm
```

**It compiled cleanly and exited 0.** Renaming the second arm's local to
`label_b` — changing nothing else — produced the correct `compile lib thing`,
which was the whole diagnosis in one edit.

Note the assignment happens BEFORE the await, so this is not about resume
ordering: the second arm's local simply never reaches the string.

## B. `error: redefinition of 'sub'`

Reproducer: [`repros/async-struct-literal-arg-redeclares-local.yo`](repros/async-struct-literal-arg-redeclares-local.yo)

```rust
base := String.from("base");
if(n > i32(0), {
  sub := String.from("one");
  return(Pair(a : base, b : sub));
});
e.io.await(yield(e.io), e.io);
sub := String.from("two");                 // <- same name, other branch
return(Pair(a : base, b : sub));
```

Building the struct literal materializes each referenced variable as a fresh C
local, but a local of that name already exists in the scope:

```c
__yo_struct_… sub = _yo…_temp_292773;       // the local
__yo_struct_… sub = sm->var_yo…_sub_1;      // materialized AGAIN
```

`fetch.yo`'s `fetch_dep` is this shape — three `sub_path :=` definitions in
three early-return branches.

## C. `error: use of undeclared identifier '_yo…_temp_487672'`

Seen in `build_runner.yo`'s `execute_node`; never reduced to a standalone file
because A and B are the same root and are minimal. A bare temp
expression-statement was emitted with its source name while the very next line
referred to the same temp correctly as `sm->var__yo…_temp_487672`:

```c
sm->var_yo…_description = _yo…_temp_487671;
_yo…_temp_487672;                                   // undeclared
fn_…___drop(… sm->var__yo…_temp_487672);            // same temp, remapped
```

This one turned out to be a THIRD, independent gap, reduced to its own 50-line
reproducer
([`repros/async-awaitless-nested-arm-bare-temp-statement.yo`](repros/async-awaitless-nested-arm-bare-temp-statement.yo)):
a reassignment inside an AWAITLESS nested match arm, beside an arm that awaits.

`generateCaseBody` in `src/codegen/exprs/match.ts` was the one statement emitter
with no bare-temp-name gate. A statement that is nothing but a temp's name is a
no-op and every other emitter drops it (`isTempVariableName`, throughout
`async/state-code-gen.ts`) — **including yo-self's own
`codegen/exprs/match.yo`**, which had the gate all along. So this is a second
case of the reference implementation being the one that was behind, and the fix
is to add the same gate with the same predicate.

Inside a state machine the omission stopped being cosmetic: the temp lives as
`sm->var_<id>`, and its source name is not a declared C identifier in the resume
function.

## Root cause

Three independent mechanisms — two keyed on the variable NAME and wrong for
sibling branches (A and B), plus a missing statement gate (C). Each one alone is
enough to produce broken output.

**1. The SSA remapping key** (`src/evaluator/shared/suspension-analysis.ts`).
`nameFrameToOriginalId` was keyed on `${name}:${frameLevel}`, and a second
variable found under an existing key was remapped onto the first's id:

```ts
const nameFrameKey = `${variable.name}:${variable.frameLevel}`;
```

That key was built for REASSIGNMENT — `offset = offset + 1` re-stamps the same
declaration with a fresh id (`assignment.ts` spreads the existing variable), and
both ids must resolve to one state-machine field. But a match/cond arm body
pushes and pops a frame, so two sibling arms' `label`s land on the SAME frame
level too, and got collapsed onto one field that only one arm ever writes.

The fix keys on the DECLARATION SITE as well. A re-stamp keeps its declaration
token; a redeclaration has its own. yo-self already carried the same idea as a
`decl_site` field on the captured variable, so its port is the same one-line key
change (`yo-self/evaluator/shared/suspension_analysis.yo`).

**2. The by-name fallback in atom codegen** (`src/codegen/exprs/atom.ts`). With
the ids kept apart, the second `label` is a segment-local — defined and consumed
without crossing a state boundary — so the SM optimizer deliberately leaves it
out of the struct and its definition emits a plain C local. The read then missed
on the id lookup and fell through to a fallback that scans
`stateMachineVariables` BY NAME, which handed back the first arm's field again.

The fix records that the env DID resolve the name to a variable that is
deliberately not an SM field (`idResolvedButNotInStateMachine`) and skips the
unaliased name matches in that case; the ALIASED matches still run, so the
closure-param `__yo_param_<i>` coordination is untouched. yo-self needed no
change here — its fallback was already declaration-site aware, from the bufio
slot-alias fix.

That second mechanism is what made variant B (`redefinition of 'sub'`) survive
the first fix on its own: the struct-literal argument path materializes a C local
named after the variable, and it was materializing it a second time from the
other branch's field.

Compare with the fixed `redefinition of 'p'` class
([here](async-match-binding-redeclared-in-state-machine.md)), which is adjacent
but not the same: that one is a match-arm DESTRUCTURING binding, and
`localShadowedVariables` covers it. This one starts from a plain `x := <expr>`
local, which that mechanism never sees.
