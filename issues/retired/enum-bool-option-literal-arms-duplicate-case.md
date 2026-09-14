# Two same-variant literal arms on `Option(bool)` — RETIRED: seed-lag artifact, not a live bug

RETIRED 2026-09-14. Filed the same day while building Phase 3b
(`match(update_module_cache_slot(...), .Some(true) => …, .Some(false) => …, .None => …`
in `src/module_manager.yo`): the self-compile died with a duplicate C `case`,
and a minimal repro "confirmed" on the installed `yo` — which turned out to be
the **v0.2.32 seed**, whose codegen predates BOTH #661 (a literal payload is
compared, not bound) and #672 (same-variant grouping + gap rules). The tree's
own compiler handles the shape correctly:

- two `.Some(<bool literal>)` arms + `.Some(_)` + `.None` lower to ONE
  `case …_SOME:` with `if ((v.data.Some.value == true))` / `== false` guards
  (verified against a freshly built develop compiler, 2026-09-14);
- without the `.Some(_)` catch-all the compiler correctly rejects the match as
  non-exhaustive (#672's gap-1 rule: literal arms are refutable);
- the runtime discrimination is covered by
  `tests/match_bind_nothing.test.yo` ("boolean literal payload
  discriminates").

The original repro omitted `.Some(_)` and ran against the seed — i.e. it
exercised the pre-#661 compiler, where every literal payload was bound as a
variable name (hence `__yo_c_reserved_true`) and no grouping existed.

What this incident actually records: **the two-generation seed rule in
practice** — `src/` may not use a pattern form the current SEED (v0.2.32, CI's
`SEED_VERSION`) cannot itself compile, because `yo build` and the CI bootstrap
leg transpile the tree WITH the seed. Phase 3b therefore binds then branches
(`.Some(patched) => if(!patched, …)`) instead of `.Some(true)/.Some(false)`
arms — the in-tree comment points here. Nothing further to fix; this retires
when a seed carrying #672 ships and the comment can go.
