# In an `io.async` body, a match arm whose body holds a value-producing INNER match with an await is emitted as NOTHING

**Status:** FIXED 2026-09-11 (`fix/async-nested-match-dead-arm`) — see "Fix" below.
Was the root cause of `issues/fixed/yo-install-git-dependency-writes-an-empty-ref.md`.
**Found:** 2026-09-11, bisecting `run_install` by body substitution. Reproduces
with `yo 0.2.30` and with develop's codegen (a gen-1 binary built from
`p1/imports-plumbing` compiling the reproducer).
**Severity:** high — the compile succeeds and the program runs, but every
statement of the enclosing arm is silently gone. `check` is clean.

## Reproducer

`issues/repros/nested-value-match-with-await-drops-the-enclosing-match-arm.yo`:

```rust
install :: (fn(parsed : Parsed, io : Io, exn : Exception) -> Impl(Future(unit, IoExn)))(
  io.async((e : IoExn) => {
    match(
      parsed,
      .Other => {
        println("other arm");
      },
      .Git(g_name, g_pinned_ref) => {
        ref_str := match(                       // value-producing inner match …
          g_pinned_ref,
          .Some(r) => { println(`pinned ${r}`); r },
          .None => {
            println("resolving");
            e.io.await(resolve(e.io, e.exn), e)   // … whose arm awaits
          }
        );
        println(`ref_str = "${ref_str}"`);
        println(`name = ${g_name}`);
      }
    );
    ()
  })
);
```

Called with `.Git(…, .Some("v0.0.6"))`, `.Git(…, .None)` and `.Other`, the
output is only `other arm` — neither `pinned`, `resolving`, `ref_str` nor
`name` is printed for either `.Git` call, and the exit code is 0.

## Bisection

| shape | result |
| --- | --- |
| inner value-match with an awaiting arm at the TOP level of the async body (no outer match) | correct |
| outer match arm with a DIRECT await (`second := e.io.await(...)`) and no inner match | correct |
| outer match arm containing the inner value-match with an awaiting arm | **the whole outer arm body is dropped** |
| same, plus a second await after the inner match (the `run_install` shape) with a sibling arm that also binds `added := await …` | C compile error instead: `assigning to 'bool' from incompatible type '__yo_t5'` — the inner arm's await result (typed as the scrutinee's `Option(String)`) is stored into the OTHER arm's `added` slot ("Extract result from await 0 (branch 2)") |

So the state-machine emitter (`src/codegen/async/`) mis-associates an await
that lives in an arm of a match nested inside another match's arm: its result
slot and type come from the wrong binding, and when nothing consumes the
mis-typed slot the enclosing arm's segment is not emitted at all.

## Consequence in the tree

`run_install` (`src/install_command.yo:594-720`) is exactly the last shape:
the `.Git(g_name, g_url, g_pinned_ref)` arm holds `ref_str := match(g_pinned_ref,
.Some(r) => …, .None => { … await resolve_latest_ref … })` followed by
`added := await append_dep_to_deps_file(...)`. Both arms' `added` are `bool`, so
the C compiles — with the `.Git` arm's progress lines, the fetch and the lock
write gone, and `ref_str` empty (the written `ref: ""`).

## Where the emitter already knows

`_emit_match_case_await_or_value` (`src/codegen/async/state_code_gen.yo:3198-3280`)
documents the gap in its own comment: when a NESTED match inside an arm
claims the dispatch slot (`sm->cond_branch_N` is shared by the outer match and
the nested one), an outer arm that has real trailing statements "keeps the
(dead-case) placement — running them cross-arm would be wrong; that gap is
pre-existing". A dead case is exactly what the reproducer shows: the outer
arm's statements after the inner match are keyed on a dispatch code that is
overwritten before resume, so they never run. The fix is one dispatch slot per
nesting level (the same "poll + store per depth" shape C36's
`_dispatch_branches` gave `cond` arms), not another special case.

## Fix (2026-09-11)

The dispatch codes `_alloc_cond_branch_codes` hands out are unique within a
function, so a nested arm's code in the shared `sm->cond_branch_N` identifies
BOTH the nested arm and the arm enclosing it. The fix keeps the single field
and one entry per await point (every legacy consumer — chained layers,
post-while continuations, the dispatch-mode switches, chained entries — keeps
identifying arms by code on that field) and adds the structure the resume
side was missing, in `src/codegen/async/`:

- **Registration** (`state_code_gen.yo`). `generate_cond_branch_with_await`
  returns a `BranchEmission(remaining, nested, codes)`. A nested cond/match in
  an awaiting arm — bare, or the RHS of `x := …` / `x = …` (the bound form used
  to fall through EVERY emitter case and emit nothing) — goes through
  `_emit_nested_cond_or_match`: a fresh `AsyncCondBranchInfo` record is
  pushed to `context.nested_cond_records` and handed to the cond/match emitter
  through `context.nested_cond_sink`, which the emitter CLAIMS at entry into
  `context.nested_cond_owner` (restored at exit) — so exactly the instance's
  own arms register in the await point's entry as usual AND in that record
  (`CondBranch.owner` names it), with its TARGETS going to the record only —
  the entry's targets stay the top-level instance's. An instance emitted inside
  one of its arm bodies some other way (a cond in a while body) finds no sink
  and registers as an ordinary entry arm, keeping its own case. The record is
  the enclosing arm's `CondBranch.nested`.
  `CondBranch.codes` is the arm's own code plus every code allocated while its
  body was emitted (nested arms, conds inside while loops, …). The legacy
  "nested claimed the slot" special cases (`_push_chained_match_arm`, the
  trivial-remaining post-while routing, the inner-wins store skip) are gone;
  `_store_cond_branch_info` always unions by code.
- **Resume** (`state_machine.yo`). The continuation switch emits an arm holding
  a nested instance as ONE case labelled with the codes `_assign_case_labels`
  gives it — within one switch each code goes to the arm with the smallest
  code window containing it (a cond in a while body over the arm enclosing the
  loop), and codes nobody more specific claims (a synchronous nested arm's,
  which never registers) go to the enclosing arm — whose body is
  `_emit_nested_level_switch` — a switch on the
  same field over the nested arms' codes that binds the taken arm's result (or
  hands it to the instance's target), recurses for deeper nesting and runs the
  nested arm's remaining code — followed by the enclosing arm's remaining code.
  Owned arms get no case of their own. Uniform (slot-guarded) points emit these
  cases AFTER the guard in `_emit_nested_branch_continuation`, with the bindings
  under a `__yo_had_future_N` C local captured before the guard, so a nested
  arm that completed synchronously (no future stored, guard skipped) still runs
  the enclosing arm's statements — once. Chained layers and post-while
  continuations test `_codes_guard(field, codes)` instead of `== index`, and
  chained records carry the arm's `codes`. Dispatch-mode suspension and
  extraction switch over the nested arms' own cases (exact future shape and
  named-ness per arm); the enclosing arm, whose code never holds the field at
  the point, gets none. A nested arm whose value IS the await hands it to its
  instance's target, resolved up the owner chain (`_branch_value_target`), and
  a bare nested instance that is the enclosing arm's tail inherits the
  enclosing level's target (`tail_of_enclosing_arm`).

Programs without nesting emit byte-identical C (`codes == [index]`, so the
labels and guards are unchanged).

**Gate:** `tests/async_await.test.yo` — "an awaiting inner match inside a
match arm keeps the arm's trailing statements", "the yo install shape: inner
match, a second bound await, an awaiting if, and a sibling arm binding the
same name", "two nesting levels: an awaiting cond inside a match inside a
match arm", "nested cond arms mixing a named and an anonymous future await
through their own access"; plus `tests/fs/dir.test.yo` (`create_dir_all`: a
nested cond whose arm holds an awaiting while and a further await) as the
regression canary for the shared-field consumers. The pre-fix compiler cannot
C-compile the batch holding the first three (the mis-typed slot).

## Fix direction (as filed)

In `src/codegen/async/` (the match/cond FSM emitters registered by
`register_fsm_emitters_impl`): when an await point sits inside a nested
value-producing match, the await's result binding must be the INNER match's
result temp, allocated per nesting level, not the enclosing arm's next
binding. Gate: this reproducer in `tests/async_await.test.yo` asserting all
five lines, plus the `run_install` shape (two sibling arms binding `added`).
(The workaround — hoisting the inner match's awaiting arm into its own async
fn — is no longer needed.)
