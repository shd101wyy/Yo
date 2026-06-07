# yo-self: signature vs def-eval-body SomeT identity splits generic instantiations

## Symptom

Under def-time body evaluation (propagation mode), a generic fn whose
signature AND body both mention the same instantiation — e.g.

```rust
zalloc :: (fn(comptime(K) : Type, comptime(V) : Type, count : usize,
              where(K <: (Eq(K), Hash, Send), V <: Send)) -> *(ZPair(K, V)))({
  ...
  match(malloc(sz),
    .Some(p) => *(ZPair(K, V))(p),          // instantiation #B (body K)
    .None => panic("alloc failed")           // typed *(ZPair#A) via fn return
  )
});
```

fails match-arm unification: `Incompatible types: Previous *(<struct:#A>)
Current *(<struct:#B>)`. Without the `where(...)` clause it passes (the CTFE
cache key compares equal and one instantiation is shared).

Real-std instance: `std/imm/map.yo:235` (`_alloc_pairs`), blocking the
whole imm/ + regex/ clusters under propagation.

## Root cause

`_build_def_time_body_env` (calls/function_type.yo) mints FRESH SomeTs for
comptime type params (`t_some_t(pn, pf_level)`), while the signature's
types carry the fn-type-eval frame's SomeTs. SomeT identity is
(name, frame_level), so the body's `ZPair(K, V)` call has different CTFE
cache-key args than the signature's → two struct instantiations with
different ids → pointer-child compat (always `require_exact`) compares the
two structs structurally → SomeT exact arm (name+level) fails on the level.

TS does not have this problem: the def-time body eval reuses the fn-type
evaluation env (`createFunctionBodyEvaluationContext` receives `env`), so
the body sees the SAME `K` SomeType object.

## Attempts that FAILED (2026-06-07) — do not retry blindly

1. **Lenient SomeT-vs-SomeT constraint-unify in `are_types_compatible`**
   (mirroring TS compatibility.ts:686-760): regressed std/string/string.yo
   ("Cannot unify usize and unit") — TS's lenient path resolves SomeTs from
   env BEFORE that code; yo-self's comparator has no env, so leniency
   over-unifies and mis-selects overloads/trials.
2. **Exact-path-only SomeT constraint-unify** (+ visited-pair cycle guard
   for `K <: Eq(K)` self-reference): the minimal repro STILL failed and
   string.yo crashed (exit 133).
3. **Reusing the signature's SomeTs in `_build_def_time_body_env`**
   (scan param/result types via get*all_some_types, bind the SAME SomeT):
   fixed the minimal repro (!), but string.yo + imm/map then crashed with
   an evaluator-recursion stack overflow
   (evaluate_function_call → property_access → evaluate_function_call …)
   — binding constraint-carrying signature SomeTs into the body env sends
   some method dispatch into infinite recursion. This is the
   TS-faithful direction; the dispatch loop it exposes needs to be found
   and guarded first (crash report: `new_specialized_T_ArgEntry*...` frame
   suggests specialization recursion).

## Suggested path

Resume from attempt 3: build it, find the dispatch loop with breadcrumb
prints on `evaluate_function_call` (callee name + depth counter), and add
the TS-equivalent recursion guard (TS likely terminates via its
specialization cache / `currentlySpecializingFunction` stack).

## Related open heads (2026-06-07 evening survey)

- **Call-result-receiver indexing inside operator calls**:
  `zs.as_bytes()(usize(0)) != u8(47)` — the chained index types u8 in a
  plain binding, but inside `!=`/`&&` the lhs synthesizes as the
  ArrayList itself ("Cannot unify <struct:ArrayList> and u8") — the outer
  application is lost in the operator's overload-dispatch path. Blocks
  std/url/index.yo, std/http/client.yo, std/http/index.yo. Repro:
  12-line fixme with String + as_bytes()(0) != u8(47).
- **json**: "Cannot unify incompatible enum types: <enum:A> and <enum:B>"
  — enum cross-module identity (same family as the struct identity; enum
  ids differ between the module's own instantiation and the importer's).
- **toml**: `.Table(...)` shorthand as a push() arg — needs the
  SPECIALIZED method param type as expected (yo-self only has the generic
  `T` at the FuncVal arm; TS re-evaluates parameter types per call).
- **arg_parser**: `err_msg` scrutinee lookup fails after a deeply-nested
  3-arg while (minimal repro attempts pass; needs the real file's nesting).

## Concrete mechanism found for the json head (2026-06-07 late)

`JsonValue :: enum(... Array(items : ArrayList(Self)) ...)` — during the
enum's own definition, `Self` resolves to an EMPTY-VARIANT EnumT shell
(fresh id, no cfid, 0 variants — yo-self's enum.yo has no
forward-declaration/patch mechanism), and `ArrayList(Self)` instantiates
— and is now GLOBALLY CACHED — with the shell as the element. Synthesis
later pairs the shell against real enums ("Cannot unify incompatible
enum types" with cfE empty and nE=0). TS represents in-definition `Self`
as a SomeType with `recursiveTypeRef`, resolved at use sites
(function.ts:133/935).

Fix sketch: enum.yo (and struct/object/union equivalents) should bind
`Self` during member-field evaluation to a recursiveTypeRef-carrying
SomeT (yo-self already has `RecursiveTypeRef` + `resolve_recursive_type_ref`
in comptime_fn.yo for the CTFE path — reuse it), and the definition's
finalization should patch/resolve. Alternatively a post-definition
substitution of the shell id by the final enum id everywhere it leaked
(cache entries included) — messier.

This same shell/placeholder-leak mechanism plausibly underlies the imm
Pair-identity split (where-clause SomeT frames), toml's shorthand
failure, and http's occurs-check on E — all four remaining families.

## ✅ RESOLVED (2026-06-07) — all four families fixed, std 151/151 under propagation

All remaining heads were fixed in one round; the full std propagation sweep
now passes **151/151** (macro-dispatch heap flakes retried).

Root causes and fixes (none matched the earlier guesses exactly):

1. **json/toml/url/arg_parser — enum CTFE cache collision** (the dominant
   head). `compatibility.yo`'s EnumT arm compared enums BY NAME ONLY with
   empty-name wildcards — and every yo-self enum has an empty name — so
   under `require_exact` (the CTFE cache key) `Option(JsonValue)` matched a
   stale `Option(T)` entry and the cache returned `Option(Option(T))`.
   Same unsoundness class as the struct fix in e3936a98. Fix: TS-faithful
   structural exact comparison (compatibility.ts:344-399 — variant names +
   field labels + field types, cycle-guarded), lenient path unchanged.

2. **Self-shell leak (json `at`, toml `.Table` shorthand)**. `ArrayList(Self)`
   instantiated during the enum's own definition captures the 0-variant
   prelim shell. Implemented the "messier alternative" from the sketch as a
   REGISTRY: the shell now carries a distinct `<id>__self_shell` id, the
   finalization registers `shell_id -> final EnumT`
   (`types/creators.yo: register_enum_final/resolve_enum_shell`), variant
   fields are one-level patched at finalization, and the resolve is applied
   at the compare site (compatibility EnumT arm), the synthesizer enum case,
   and both enum-variant-lookup sites in `property_access.yo`.

3. **http — false "infinite type E" occurs check**. `E := IoExn` tripped
   `_occurs_check` because the value-typed `IoExn` struct copy embeds
   `Io.await : fn(forall(T, E), …)` — the SAME SomeT ids as the call's
   foralls. In TS each fn-type evaluation mints fresh SomeType objects
   (implicit alpha-renaming), so the ids never coincide. Fix: forall
   SHADOWING in `_occurs_check` — a Func declaring a forall whose NAME
   equals the searched variable's name stops the search (sound: within
   `fn(forall(E), …)` any SomeT named `E` lexically IS the inner one).
   Also restored the TS message (`with type "…"`), which exposed the bug.

4. **imm×4 — the original sig-vs-body SomeT split**. Attempt 3 from this
   doc now WORKS: `_build_def_time_body_env` scans the signature's param +
   result types (`get_all_some_types`) and binds a comptime type param to
   the SIGNATURE's own SomeT (minting only when the signature never
   mentions it). The dispatch recursion that killed attempt 3 in early
   June no longer reproduces — the intervening identity fixes (CTFE exact
   compare, comptime-string coercion, runtime-return gating, callee
   expected clearing) removed the loop.

Also landed: the inline FuncVal arm in `calls/function.yo` now resolves
leftover SomeTs in the return type from the callee env
(`evaluate_function_return_type_again`) — the helper.yo path already did
this (Step 9); the inline arm is yo-self's second call path.
