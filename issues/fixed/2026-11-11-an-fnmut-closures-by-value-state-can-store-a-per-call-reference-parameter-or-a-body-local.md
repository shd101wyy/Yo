# An `FnMut` closure's by-value state can store a per-call reference parameter or a body local

**Severity:** S1. An `FnMut` literal whose capture list keeps its own reference-holding state,
`{ last : Option(&Rc(X)).None }(v : &Rc(X)) => { …; last = .Some(v); }`, passes `yo check`: the store keeps the
per-call argument past the call, and the next call reads it after the caller's argument died (ASan:
stack-use-after-return). Storing `&k` of a body local is the same (stack-use-after-scope). Pre-existing: v0.2.76
accepts both. The same store through a `&mut` capture (`{ s : &mut slot }`) is E0923, and through `Dyn(FnMut)` E0909.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A35). Confirmed on develop `64f33c710`. The design half
(ledger CL-F5: the plan did not say what origin a by-value entry has) is covered under "Expected".

## Reproducers

`issues/repros/2026-11-11-an-fnmut-closures-by-value-state-can-store-a-per-call-reference-parameter-or-a-body-local.yo`
(negative, expects E0923):

```yo
each :: (fn(f : &mut Impl(FnMut(v : &Rc(X)) -> unit)) -> unit)({
  {
    k := Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
    f(&k);
  };
  k2 := Rc.new(X(s : String.from("z")));
  f(&k2);
});
main :: (fn() -> unit)({
  each(
    &mut ({ last : Option(&Rc(X)).None }(v : &Rc(X)) => {
      match(&last, .Some(r) => println(`OUT: ${r.*.*.s.len().to_string()}`), .None => ());
      last = .Some(v);
    })
  );
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ ASAN_OPTIONS=detect_stack_use_after_return=1 ./t     # --optimize 1 --sanitize address --allocator system
==…==ERROR: AddressSanitizer: stack-use-after-return
```

- `…-body-local.yo` (negative, E0912): the body makes `k := Rc.new(…)` and stores `y := &k` into `last`; the second
  call reads it. Accepted, stack-use-after-scope.
- `…-pos.yo` (positive control): the state is `Option(Rc(X))` and the body stores `Rc.clone(v)`. Accepted, runs clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| by-value entry `{ last : Option(&T).None }`, `last = .Some(v)` from the literal's parameter | accepted, stack-use-after-return | E0923 |
| the same with `&String` parameters (ledger h06) | accepted, stack-use-after-return (ledger, base) | E0923 |
| by-value entry, `last = .Some(&k)` of a body local | accepted, stack-use-after-scope | E0912 |
| the same shape as an `xs.retain(&mut ({ prev : Option(&String).None }(v) => …))` predicate | accepted; `OUT: 0` where reading the previous element keeps one (ledger) | E0923 |
| the same literal boxed as `Dyn(FnMut(v : &String) -> unit)` | E0909 | E0909 |
| the store through a `&mut` capture, `{ s : &mut slot }(v) => { s.* = .Some(v); }`, or a helper with a spelled origin | E0923 (ledger: five probes) | E0923 |

## Root cause

`evaluate_anonymous_function_implementation` (`src/evaluator/values/anonymous_function.yo`) binds an `FnMut` literal's by-value
entry in a frame it pushes for the literal, as a writable non-owning local (`ce_fnmut_state`,
`mark_fnmut_capture_value_binding`); `binding_require_mut` (`src/evaluator/utils.yo`) lets the body write it
(VERDICTS-15 Q1). A store into it reaches `bind_join_roots_for` (`src/evaluator/utils.yo`). That function judges a
store as leaving the body only when the holder has a `borrow_capture_outer` record, which only `&mut` entries get
(`_capture_store`: E0923 for a per-call parameter root, E0912 for a body local). A by-value entry has none, so the
store falls through to the ordinary local-holder join, which records `v`'s or `k`'s origin on `last` as if `last` were
a local of the body. Hypothesis for why nothing then fires: `last`'s frame ends with the literal's evaluation, so no
scope-end check ever sees a holder that outlives the root; the entry's real lifetime (the closure record, across
calls) is not modelled. The entry's own type origin is never fixed either: `Option(&Rc(X))` is elided, so its
"declared" origin set is whatever the stores join into it.

## Expected

E0923 at `last = .Some(v)` (E0912 for the body local). `REFERENCES_AND_ORIGINS.md` O7 "Closures" covered `&`/`&mut`
entries only; the audit's worktree adds the missing sentence there (2026-11-11, A35): "A BY-VALUE entry whose type
holds a reference (`{ last : Option(&T).None }`) has its origins fixed at the literal, from the initializer (the empty
origin for `.None`); an `FnMut` body's write to the entry is a store through `&mut self` and is checked as one, so the
body cannot store a per-call parameter or one of its own locals into its state." `BORROW_CHECKER_COMPLETENESS.md`
R-CLOSURE-LIT ("a by-value capture of an origin-carrying value is its origin") and §4's "a store from a parameter into
a capture or another parameter fails `lend_through`'s exact unification (H2's rule)" then apply unchanged: the fix
gives the by-value entry the same store judgement `_capture_store` gives a `&mut` entry, with the outer origin set
fixed at the literal instead of joined.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`closure-fnmut-state-stores-param` (E0923) and `closure-fnmut-state-stores-body-local` (E0912) in
`tests/origins/corpus.tsv`; `tests/fn_mut.test.yo` gains both beside its `Array(i32, 2)` state test.

## Fix

`fix/c7-captures` (audit §9 cluster 7). `bind_join_roots_for` (`src/evaluator/utils.yo`) sends a store whose holder
is an `FnMut` literal's by-value entry (`is_fnmut_capture_value_binding`) to `_capture_state_store`. That function
judges each ground root as a store through `&mut self`: a root at the literal's per-call parameter is E0923, a body
local or another by-value entry of the literal (its own storage) is E0912, and a borrow capture's place, an implicit
capture or a module-level binding passes. The entry's origin stays the one fixed at the literal (O7), so nothing is
joined. The `Dyn(FnMut)` form keeps E0909.

Tests: `tests/origins/unsound/c7-fnmut-state-stores-param.yo` (E0923), `c7-fnmut-state-stores-body-local.yo`
(E0912) and `c7-fnmut-state-stores-param-pos.yo` (accept, runs clean under ASan); `tests/fn_mut.test.yo` "FnMut:
by-value state may not keep a per-call parameter or a body local", including a borrow-capture store that passes. The
corpus rows the Test section suggests are deferred; the G-B rows pin the same programs.
