# `g_match_arms` kept every re-evaluation's compiled arms (LSP / watch)

Found 2026-09-27 by the Linux holder census (`plans/EVALUATOR_MEMORY_REDUCTION.md`
§0.18); first fix in #957, reworked 2026-09-27 (this record). **Fixed.**

## Symptom

`src/pattern.yo`'s `g_match_arms : HashMap(usize, ArrayList(Arm))` holds the
compiled arms of every `match`, keyed by the match node's expression id. Only
codegen reads it (`lookup_match_arms` in `codegen/exprs/match.yo` and
`codegen/async/state_code_gen.yo`). Every re-evaluation of a module mints fresh
expression ids, so in `yo lsp`, `check --watch` and `build --watch` each round
added a new generation of the module's matches and nothing removed the old
one.

At `check src/main.yo` exit the census counted 18,105 entries: 35,125 `Pattern`
objects, 19.7 MB first-reach (the deep walk on 2026-09-27). Each `Pattern`
showed exactly one reference the unreached set could not explain. That
reference is the untracked `Arm` that holds it. The `Arm`s sit inside an
untracked `ArrayList(Arm)` in the registry, so the traverse-based census saw
them as leak roots. They are not leaks: in a one-shot command there is only
one generation, and it is what codegen reads.

## What #957 did, and why it was reworked

#957 added a second, parallel owner index (`g_match_arm_owners`) keyed by the
match token's `module_path`, plus a `purge_match_arms_owned_by(owner)` called
from `mm_invalidate_document`. That had three problems:

- **The owner key never matched for the entry module.** Entry-module tokens
  carry the path as typed. `mm_invalidate_document` purges by the
  `file://<abs>` cache key. Comparing the two spellings with `==` is the
  documented pitfall (AGENTS.md, "Two spellings of a module path coexist").
- **It recorded in one-shot commands.** The index grew by every match id in
  `check`, `compile`, `test` and `verify`, which §0.15 had just made free of
  owner logs.
- **It duplicated an existing mechanism.** ExprId-keyed side tables already
  have one: `record_owned_expr_id` logs the id under `registration_owner()`
  (the module being evaluated or lazily forced, off in one-shot commands),
  and `mm_invalidate_document` hands `take_owned_expr_ids(owner)` to
  `purge_expr_side_tables`.

Its test called `register_match_arms` / `purge_match_arms_owned_by` directly on
a fabricated owner, so it could not see either problem.

## Fix

`register_match_arms` records the id with `record_owned_expr_id`. The removed
module's `take_owned_expr_ids` list now feeds `purge_match_arms` as well as
`purge_expr_side_tables` (`src/module_manager.yo`). The parallel index is gone.

Test: `tests/internal/module_invalidation.test.yo` "match-arm registry:
re-analysis keeps it flat". It analyzes a document with two matches three
times through the real LSP path and asserts the registry count is flat. It
fails without the purge line and passes with it.

A one-shot `check` could skip the registry entirely, since nothing reads it
without codegen. That saves about 20 MB first-reach. It is left for the
registry sweep (plan Phase 1 step 5), which decides per table what a
non-codegen command keeps.
