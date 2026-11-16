# A closure whose captures are all references is accepted by `with_mut`'s `sink` parameter; add one owned capture and the same reference capture is E0909

**Severity:** S2 — the checker gives two answers for one capture: `{ tok }` and `{ tok : &tok.* }` (where `tok : &Token`) pass into `RefCell.with_mut`'s `sink(body)` alone and fail with E0909 beside an owned capture, so either a borrow is moved into a by-value slot (an accepted invalid program; no exploit found) or a valid program is rejected.

- Filed: 2026-11-16 (retype lane, 3c prep PR). Found by `VERDICTS-64` §4 decision 22 (probes `v0273/fable/probe-64/src/`); reproduced here with stage 1 of develop `96c5b029e`. Not fixed.
- Open question: which reading is the rule. By decision 38 A's letter ("a second-class value is never moved into a by-value parameter") and `_param_accepts_second_class` (`src/evaluator/calls/helper.yo`), whose exceptions do not include `with_mut`, the accepted forms are the hole. By the "a generic callee is checked per call" argument, the rejected mixed forms are a wrong rejection.
- **Until this is ruled on, no reference capture goes into a closure passed to a `sink` parameter** in the retype batches (3c–3e). Such a closure captures values, and anything it reads from the handle is computed before the call (VERDICTS-64 decision 18). This holds even where the reference capture checks. The prep PR for 3c hoists ten such keys for this reason.

## Accepted

`TokD :: struct(off : u32, path : String); Tok :: Rc(TokD);` and a module-level
`(g_keys : RefCell(HashSet(String)))`, as in the probes. `yo check` passes:

```yo ignore
note :: (fn(tok : &Tok) -> unit)({
  _new := g_keys.with_mut({ tok }(s) => s.insert(key_of(tok)));            // rc_f_named_ref_sunk
});
note2 :: (fn(tok : &Tok, other : &Tok) -> unit)({
  _new := g_keys.with_mut({ tok : &tok.*, other : &other.* }(s) => s.insert(key2(tok, other)));  // sunk_g_two_refs
});
```

`rc_e_reborrow_sunk` (`{ tok : &tok.* }` alone) passes too, under both stage 1 and the v0.2.77 seed. `{ tok }` is the
spelling E0901's own help recommends.

## Rejected

```yo ignore
note :: (fn(tok : &Tok, other : &Tok) -> unit)({
  pre := String.from("p");
  _new := g_keys.with_mut({ tok : &tok.*, pre }(s) => s.insert(`${pre}${key_of(tok)}`));   // sunk_h_mixed_owned_string
});
```

```text
error[E0909]: This value borrows `tok` (the capture `tok : &tok` at sunk_h_mixed_owned_string.yo:12:29), so it is second-class and cannot be moved into a by-value (`sink`) parameter: a borrow never outlives the scope that lends it.
   --> sunk_h_mixed_owned_string.yo:12:52
help: capture a value instead (`{ tok : tok.clone() }`), or keep the closure local to the scope that owns `tok` and call it there
```

`sunk_f_mixed_clone_and_ref` (`{ tok : &tok.*, other : Rc.clone(other) }`) gets the same E0909. A non-generic
`keep :: (fn(sink(f) : Impl(Fn() -> u32)) -> Impl(Fn() -> u32))(f)` rejects `{ tok }` (`sunk_j_named_ref_escapes`) and a
reborrow of a local (`sunk_i_escape_via_identity`). So the plain escape is closed, and the inconsistency is limited to a
generic `sink` callee given a closure with nothing but reference captures.

## What a fix needs

The first step is a verdict on the rule. If its letter stands, the reference-only forms become E0909, and every tree
site that relies on them moves to a hoisted value (the retype prep PRs already do this for `Token`). If the per-call
reading is the intent, the mixed forms are accepted and `{ tok }` becomes the one-token spelling. Either way, the
regression test goes in `tests/` beside the capture-list tests with both shapes and one expected verdict.
