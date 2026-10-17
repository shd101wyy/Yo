# How a non-`Copy` `mut(G)` global is read once buffers are unique

**Kind:** design question — an open decision, not a defect.

**Status:** OPEN — found 2026-10-17 while landing decision 47 globals
Generation B (#1414). It matters at V2b unique buffers Generation B, not
before.

## The two rules that meet

- Decision 47 (plans/VALUES_BY_DEFAULT.md §6, step 1): lending a `mut(G)`
  global, or a place under it, to any call is E0916. That includes the
  receiver of a `&self` method, so `G.clone()`, `G.len()` and `G == x` are
  E0916 on a `mut(G) : String`. The sanctioned rewrite is "copy it out":
  `v := G; f(&v)`.
- V2b unique buffers Generation B (plans/VALUES_BY_DEFAULT.md §0.2): an
  implicit copy of an explicit-copy value (`String`, the collections, a
  `Box`, an `Option` of one) whose source stays alive is E0901, and the
  copy is spelled `x.clone()`. A module-level source is never moved from
  (`YO_AUDIT_IMPLICIT_COPY` reports it "at once"), so `v := G` is always
  such a copy.

Together, a `mut(G)` global of an explicit-copy type cannot be read at
all: `v := G` is E0901, and `v := G.clone()` is E0916.

## Where the tree has them after #1414

#1414 rewrote 88 E0916 lends in std and src. The ones on `Copy` globals
(`usize` counters, `Option(i64)`, `Option(*void)`, `std/rand.yo`'s
`_RngState`) are unaffected. These read an explicit-copy global by copy
and hit the conflict at V2b Generation B:

- `String`: `_registration_owner`
  (`src/evaluator/values/type_trait_methods.yo`), `g_current_owner`
  (`src/utils.yo`), `g_error_format` (`src/diagnostics.yo`),
  `g_traverse_visit_expr` (`src/codegen/functions/constructors.yo`),
  `g_synthetic_token_last_module` (`src/env.yo`), `g_transparent_reason`
  (`src/verifier/vc.yo`);
- `Option(String)`: `g_parse_error` (`src/lsp/diagnostics.yo`),
  `g_std_path_override`, `g_imports_file_override`
  (`src/module_manager.yo`).

The `match(G, .Some(_) => …, .None => …)` reads that #1414 uses for
`g_cached_prelude_env` and `g_shared_expr_info_table` lend nothing and
copy nothing, so they survive.

## Options

1. **Exempt a structural `clone()` of a `mut(G)` from E0916.** A `Clone`
   that is derived or std-structural copies the buffer and runs no user code,
   so nothing can reach `G` while the borrow lasts. A user `impl(T, Clone)`
   stays E0916.
2. **Keep the explicit-copy globals unmarked.** Move each one behind a
   handle (`RefCell(String)` from decision 46 Generation A, or a
   `thread_local(mut(...))` of a `Copy` id), and write through
   `with_mut`.
3. **Let `v := G` of a module-level source lower to a clone without E0901.**
   The copy is still an O(n) clone, only now it is implicit. That undoes V2b's
   "copies are never implicit" for exactly this case.

## Recommendation

Option 1. The E0916 hint already tells users to write
`v := G.clone(); f(&mut v); G = v;`, which is only sound if a structural
clone is allowed. The check is local: the receiver's `Clone` impl is
derived or comes from std's structural impls (the same test
`type_is_bitwise_copy`'s neighbours make for decision 36). Option 2 remains
right for a global that is written often, but it should not be forced on a
`String` that is set once per command. Decide before V2b unique buffers
Generation B sweeps src, since that sweep is where the nine globals above
start to fail.
