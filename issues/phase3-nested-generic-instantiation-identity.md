# Phase 3 blocker: generic method returning `Self` containing a `String` field → spurious "Cannot unify i32 and usize"

## Status

Open — the **dominant Phase 3 blocker** (`check ./yo-self` = 53/227; **170 of
172 fails** are this one bug, via the shared global
`type_trait_methods.yo:130` `(_type_trait_methods : HashMap(String,
ArrayList(MethodEntry))) = HashMap(...).new()`). This doc records the **clean
minimal repro** isolated this session — far simpler than the HashMap cases that
all prior ~8 attempts worked on (see memory `yo-self-phase3-generic-impl-funcid`
for the full attempt history; **do not re-try funcId-stamp+guard alone — net-≤0
×4+ and SIGBUS-prone**).

## Minimal reproducer (no HashMap)

```rust
open(import("std/string"));
M :: (fn(comptime(K) : Type) -> comptime(Type))(object(x : K));
impl(forall(K : Type), M(K), make : (fn(v : K) -> Self)(Self(x : v)));
(_m : M(String)) = M(String).make(String.from("hi"));   // FAIL: Cannot unify "i32" and "usize"
```

**Discriminator (the key clue):**

| variant                                               | result                     |
| ----------------------------------------------------- | -------------------------- |
| `M(i32).make(i32(7))` (value-type arg)                | **OK**                     |
| `M(String).make(String.from("hi"))` (RC/newtype arg)  | **FAIL** ("i32 and usize") |
| `M(String).get() -> i32` (returns i32, no `Self(..)`) | **OK**                     |
| `T :: HashMap(String, ArrayList(Foo))` (type only)    | **OK**                     |
| `M.new() -> Self` (NON-generic `M :: object(...)`)    | **OK**                     |

So: pre-existing (identical on pre-session `cs11`); NOT type-instantiation, NOT
basic generic method resolution (both work after this session's
`constructor_func_id`/`type_arguments`/impl-forall fixes); specifically
**constructing/returning a `Self` whose field is a `String`** (a newtype wrapping
`Option(ArrayList(u8))`).

## Mechanism (re-derived; matches the memory)

The annotated `(_m : M(String)) = …` adds a compatibility/synthesize step. With a
`String` field, the synthesizer descends `String` vs `String` → into the nested
`Option(ArrayList(u8))` instantiations. Those **nested generic instantiations are
unstamped / not identity-matched** (empty/ mismatched `constructor_func_id`), so
`same_constructor` is false and the synthesizer **recurses into their field
type lists** — which are misaligned/мис-substituted enough that an `i32` field
meets a `usize` field → "Cannot unify i32 and usize". (`i32`/`usize` are
unrelated to `String`/`M` — pure machinery artifact of field-recursion on
non-identity-matched nested instantiations.) The `:=`-infer form "passes" only
because it binds `_m : <whatever .new()/.make() yields>` with no compat check
(silently wrong, like html.yo's original behaviour).

## Why it's hard (the Stage-4 knot)

The fix is per-instantiation **type identity** for nested generic
instantiations so synthesize matches them by constructor and never recurses into
their fields. Prior attempts that stamped nested/inline-built structs
**re-SIGBUS'd recursive generics** (imm_vec/imm_threading) because the
id-cycle-guard needs _stable_ ids — which requires routing the inline/nested
construction path through the memoized `evaluate_comptime_fn_call` (stable id +
stamp), not ad-hoc stamping. That routing was itself blocked because the
annotation/inline callee resolves to a Func whose return is a _specialized
struct_ (neither bare `Type` nor comptime-only), so no predicate classifies it
as a type-constructor return to trigger memoization.

## Recommended approach for the next focused effort

1. Work against the **minimal `M(String).make()` repro above**, not HashMap —
   it isolates the nested-instantiation identity bug with no `_alloc`/`malloc`/
   `where`/`Result` noise, so iteration is fast.
2. Pin the exact throw: breadcrumb the top-level pair at `synthesizer.yo`'s
   public `synthesize_types` entry, print it at the tag-mismatch throw
   (`synthesizer.yo:~1762`). Confirm the recursing pair is a nested
   `Option`/`ArrayList` instantiation.
3. Make nested instantiations carry stable per-instantiation identity (route
   their construction through memoization) so `same_constructor` short-circuits
   the field recursion — WITHOUT re-breaking recursive-type termination
   (validate imm_vec/imm_threading/priority_queue do not SIGBUS).
4. **ALWAYS** validate with a per-file baseline-vs-fix exit-code diff (build a
   HEAD baseline binary + the fix binary, `join` per file) — the aggregate count
   has hidden "0 improved" ≥4 times. Revert on any regression/SIGBUS.

## Measurement note

`check ./yo-self` / `check ./tests` SIGSEGV in full-directory mode (cross-file
state pollution, entangled with prelude-populated registries — a harness
limitation, not an evaluator bug). Measure **per-file by exit code**; single
files and subdirs check fine. circular_deps SIGSEGV was fixed separately
(`d2732a2f`).
