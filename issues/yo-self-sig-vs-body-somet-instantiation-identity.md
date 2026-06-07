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
