# Retire the `&`-prefixed pointer operators — traits for comparison, methods for arithmetic

_Status: EXECUTED (`8acde607a`, 2026-07-27; TIER 1 green — corpus 141/0,
battery 6-flag baseline, std 153/153; TIER 2 GREEN incl. STRICT_FIXPOINT, stage2 real hollow=1 baseline —
/tmp/t2_mig.log). Breaking language
change (`feat(lang)!`), same class as the `forall` → `generic` rename._

**Execution notes:** risk #2 (unsafe-gate placement) was real — the gate
moved to pointer-receiver method resolution in `src/evaluator/calls/
function.ts`; yo-self never had the arithmetic gate (pre-existing unported
gap, unchanged). A NEW pre-existing yo-self bug surfaced and is documented
with bisect + repro in `issues/fixed/yo-self-ptr-eq-trait-call-in-shortcircuit.md`:
a trait-dispatched pointer `==` as a `||` LHS miscompiles (corpus rc=133);
`std/string/string.yo`'s fast path therefore calls `__yo_ptr_eq` directly.
The flowability rule needed the method forms (both compilers,
pointer-receiver-gated). `&-` hand-audit: only 1 real site existed (the
prelude impl itself) — raw grep counts were comment/string noise.

## Motivation

The `&`-prefixed operator family (`&==`, `&!=`, `&<`, `&<=`, `&>`, `&>=`,
`&+`, `&-`, `&/`) existed to distinguish pointer arithmetic/comparison from
operations on the pointee, back when mutation required passing raw pointers
around. Two things changed:

1. **`inout` removed raw pointers from safe code.** Safe APIs take
   `inout(name) : T` or reference-semantics objects; `*(T)` now only appears
   in pragma'd internals and FFI, where address semantics are the only
   sensible reading of a comparison.
2. **Discoverability is measurably bad.** `p == q` on two `*(u8)` fails
   overload resolution with no hint that `&==` exists (only `*(void)` has a
   plain `Eq` impl). This bit an agent session on 2026-07-27 — the fix
   attempt went through casts and a local extern before finding `&==`.

Rust is the model: raw pointers implement `PartialEq`/`Ord` directly
(`p == q` compares addresses), while arithmetic is **methods, not
operators** — `p.add(n)`, `p.sub(n)`, `p.offset_from(q)` — because offsetting
is where the UB lives and should stay typographically loud inside unsafe
blocks. Yo already gates arithmetic behind `unsafe(...)`; the method form
keeps that visibility without a parallel operator grammar.

## Design

### Comparison → plain trait impls (safe, no `unsafe(...)`)

Replace the prelude's `(&==)/(&!=)/(&<)/(&<=)/(&>)/(&>=)` members of
`impl(generic(T : Type), *(T), ...)` (std/prelude.yo:5530) with:

```rust
impl(generic(T : Type), *(T), Eq(*(T))(
  (==) : ((lhs, rhs) -> __yo_ptr_eq(lhs, rhs)),
  (!=) : ((lhs, rhs) -> __yo_ptr_neq(lhs, rhs))
));
impl(generic(T : Type), *(T), Ord(*(T))(
  // <, <=, >, >= via __yo_ptr_lt / lte / gt / gte
));
```

The existing standalone `impl(*(void), Eq(*(void))(...))` (prelude:5516)
folds into the generic impl. Semantics: **address identity**, exactly like C
and Rust. Optional-pointer (`?*(T)`) comparisons go through the usual Option
Eq once the inner impl exists.

### Arithmetic → unsafe methods, Rust names

```rust
impl(generic(T : Type), *(T),
  /// p &+ n  →  p.add(n)     (offset by n elements, forward)
  add : (fn(self : Self, count : usize) -> Self)(__yo_ptr_add(self, count)),
  /// p &- n  →  p.sub(n)
  sub : (fn(self : Self, count : usize) -> Self)(__yo_ptr_sub(self, count)),
  /// p &/ q  →  p.offset_from(q)   (element distance, signed)
  offset_from : (fn(self : Self, origin : Self) -> isize)(__yo_ptr_diff(self, origin))
);
```

These stay inside the existing `unsafe(...)` gate (the `__yo_ptr_add`-family
builtins are already the gated operations; the unsafe-gate check keys on the
builtins, so the method bodies inherit it — verify, else move the gate to the
methods). `&/` becomes `offset_from` — the operator actively misread as
division; the method name states the contract (both pointers into the same
allocation, result in elements).

Codegen is untouched: both compilers lower the `__yo_ptr_*` builtins inline
(`src/codegen/exprs/inline-fns.ts:146-176`, `yo-self/codegen/exprs/
inline_fns.yo` via `BF_YO_PTR_*` from `expr.yo:115`), and the methods call
the same builtins. Only the prelude impl surface and call sites change.

## Usage counts (measured 2026-07-27, `grep -F`, `&&` lines excluded; counts

include the prelude impl definitions themselves)

| operator           | std (lines/files) | yo-self | tests        | replacement       |
| ------------------ | ----------------- | ------- | ------------ | ----------------- |
| `&==`              | 2 / 2             | 2 / 1   | 2 / 2        | `==`              |
| `&!=`              | 1 / 1             | 1 / 1   | 0            | `!=`              |
| `&<` (excl. `&<=`) | 1                 | 2       | 1            | `<`               |
| `&<=`              | 1 / 1             | 1 / 1   | 2 / 1        | `<=`              |
| `&>` (excl. `&>=`) | 1                 | 1       | 1            | `>`               |
| `&>=`              | 1 / 1             | 1 / 1   | 2 / 1        | `>=`              |
| `&+`               | **306 / 31**      | 18 / 12 | **206 / 31** | `.add(n)`         |
| `&-`               | 1 / 1             | 5 / 3   | 4 / 2        | `.sub(n)`         |
| `&/`               | 1 / 1             | 2 / 2   | 1 / 1        | `.offset_from(q)` |

Comparison migration is trivial (~20 lines total, mostly the prelude impls).
The real volume is **`&+`: ~530 lines across 74 files**, dominated by std
buffer internals and tests — mechanical (`X &+ Y` → `X.add(Y)`), scripted
with a scanner-based rewriter (same approach as
`scratchpad/rewrite_string_from_cmp.py`; must respect string literals and
parenthesization — `(ptr &+ 1).*` → `(ptr.add(1)).*`).

## Migration plan

1. **Prelude**: add the `Eq`/`Ord` impls and the three methods alongside the
   `&`-operators (both surfaces live simultaneously).
2. **Scripted rewrite** of std/, yo-self/, tests/ call sites (per-operator
   scanner; `&-` needs care — audit each of the 10 sites by hand rather than
   pattern-matching `&-` which collides with unary-minus text).
3. **Remove the `&`-operator members** from the prelude impl. Decide the
   error UX: the lexer keeps tokenizing `&==` (generic operator lexing), so a
   stale call site fails overload resolution — add a targeted hint
   ("deprecated: use `==` / `.add(n)`") in the no-matching-call error when
   the operator name starts with `&` and the receiver is a pointer.
4. **Docs/skills**: rewrite the pointer-operator bullets in
   `.github/skills/yo-syntax/syntax-cheatsheet.md` and
   `.github/instructions/yo-syntax.instructions.md` (both updated 2026-07-27
   with the OLD family — they must flip in the same commit), plus
   `docs/en-US` + `docs/zh-CN` pointer sections and
   `scratchpad`/`plans/reference/MEMORY_SAFETY.md` references.
5. **Gates**: TIER 1 (corpus 141/0, battery at 6-flag baseline, std 153/153)
   then full TIER 2 incl. STRICT_FIXPOINT — the yo-self tree is rewritten
   too, so the self-compile exercises the new surface end-to-end. The
   `public-safe-report` must stay at 0 findings.

## Decisions taken (from the 2026-07-27 discussion)

- **No deprecation window** — hard flip, matching the `forall → generic`
  precedent (`60d1c9920`); pre-1.0 language, single migration commit chain.
- **Identity-vs-value note**: for reference-semantics types (`ref(struct)`),
  `a == b` remains VALUE equality via their `Eq` impls, while `*(T) ==` is
  ADDRESS identity — same split as Rust (`Rc` `==` vs `Rc::ptr_eq`). Document
  in the pointer sections; the interned-string fast path in
  `std/string/string.yo`'s `==` (uses pointer identity as an optimization)
  is the canonical example of the two being different questions.
- `offset_from` follows Rust's argument order: `end.offset_from(origin)`.

## Risks

- `&+` rewrite volume (~530 lines): mechanical but must be gated like any
  refactor; the scripted rewriter needs unit tests against the tricky forms
  (`(p &+ i).*`, `p &+ (n * k)`, chained `p &+ a &+ b`).
- Unsafe-gate placement: verify the gate still fires for `.add(n)` outside
  `unsafe(...)` — the gate must key on the builtin call inside the method
  body being inlined, or be re-attached to the methods explicitly.
- Method-name collisions: `*(T)` currently has no inherent methods, but
  `add`/`sub` are common trait-member names — inherent-first resolution
  (already the language rule) keeps pointer `.add` from shadowing user
  traits on OTHER types; confirm no `Impl(Add)`-style generic code tries to
  call `.add` on pointers expecting trait dispatch.
