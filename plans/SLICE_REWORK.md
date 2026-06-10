# Slice rework — static `str`, delete builtin `Slice(T)`, library views

**Branch:** `feat/slice-rework`. **Decision** (resolves
`issues/slice-invalidation-design.md`): instead of snapshot slices (rejected —
Rc/CoW overhead on every slice copy to defend against rare misuse), remove
borrowed raw views from the safe surface entirely. After this rework, **safe
code cannot construct any value that carries a raw pointer into mortal
storage** — the slice-invalidation hole (all three triggers: backing
reassignment, realloc-on-growth, Rc-alias mutation) becomes *unconstructible*
rather than gated.

## The design

### 1. `str` — builtin immutable view of STATIC string data

- `str` means "a view of string bytes in **static storage**": string literals,
  template-literal segments, and `comptime_string` values materialized to
  static data. The backing is immortal ⇒ `str` is trivially safe: freely
  copyable, storable in fields, returnable — **no flowability constraints, no
  Rc, no runtime cost**.
- This aligns `str` with `comptime_string`: a compile-time string IS static
  data; the comptime→runtime materialization of a string is exactly a `str`.
- **`String.as_str()` is DELETED** — not merely discouraged: under the new
  model it has no honest implementation. `z := (x + y)` builds its bytes in a
  heap buffer at runtime; if `str` means "view of static storage", there is
  no valid `str` for `z.as_str()` to return. The three conceivable
  implementations all fail: a heap view violates the `str` invariant (the
  exact hazard being deleted); "copy to static storage" doesn't exist at
  runtime; interning/leaking an immortal buffer is a worse footgun than the
  one removed. The surviving asymmetry is the correct one: `String.from(s :
  str)` (static → heap copy) stays; heap → `str` is impossible by design.
  Privileged (pragma) code may keep an unsafe-marked raw-view equivalent
  where genuinely needed (C interop), but std APIs stop returning borrowed
  views of heap strings.
- Replacement for the dominant pattern (measured: 2186 `as_str()` call sites
  in yo-self, the majority `x.as_str() == "literal"`):
  - Add `Eq(str)` on `String` (`String == str` compares bytes directly — no
    view construction, strictly faster than today). Most call sites become
    `x == "literal"`.
  - `starts_with(str)` / `ends_with(str)` / `contains(str)` / `find(str)`
    overloads on String where the std doesn't already have them.
  - Code that truly needs a substring gets one: `substring` already returns
    an owned `String` (copy) — unchanged.
  - `String.from(s : str)` stays (copies static bytes into a heap String).

### 2. builtin `Slice(T)` — DELETED

(Decision upgraded from "demote" after a usage census — see below.)

- The builtin generic `Slice(T)` type is removed from the language: TypeTag,
  evaluator handling, codegen lowering, prelude impls and the `__yo_slice_*`
  extern builtins. The compiler keeps exactly ONE fat-pointer lowering:
  `str`'s (which becomes a self-contained builtin, no longer a newtype over
  `Slice(u8)`).
- **Census that justified deletion** (2026-06): safe user code ≈ nil (the
  test mentions are dominated by the flowability tests that test the slice
  gates themselves); std public API exposure = `as_slice` + Array
  range-indexing + 1 hash use (all already slated for removal); std internals
  = 10 files, ALL pragma'd, using Slice only as a ptr+len convenience;
  compiler surface = 147 refs across 27 src/ files + the yo-self ports —
  deletion removes an entire TypeTag and SHRINKS the upcoming codegen-port
  surface.
- **Pragma'd internals replacement**: a library struct in a pragma'd std file
  — `RawSlice(T) :: struct(ptr : *(T), len : usize)` — gives `imm/*`,
  `crypto`, `ArrayList` plumbing and C interop the same convenience with zero
  compiler machinery. Naming it still requires the pragma (it contains
  `*(T)`, so the existing raw-pointer naming gate already covers it for
  free).
- `ArrayList.as_slice()` is removed (same fate as `as_str`).
- **Range-indexing becomes COPYING (JavaScript-style)** — decided: instead of
  returning a borrowed view, `arr(0..5)` returns an owned COPY of the range.
  Return types: `Array(T, N)` / `ArrayList(T)` ranges → a new `ArrayList(T)`
  (range extents are runtime values, so the fixed-size `Array` form can't be
  the result type); `String` range-indexing → a new `String` (consistent with
  `substring`, which already copies). `str` range-indexing STAYS a zero-copy
  `str` — a window of static data is still static. Element indexing is
  unchanged everywhere. This keeps slicing ergonomics with value semantics
  and removes the last borrowed-view producer from the safe surface.

### 3. Safe windows — library view types over the owning handle

Safe code that wants a sub-range view uses an **alias view** that holds the
Rc'd backing and indexes through the LIVE handle:

```rust
// std/collections (sketch) — value semantics, no new machinery:
ListView :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(backing : ArrayList(T), offset : usize, len : usize)
);
// get(i): bounds-check i < len AND (offset+i) < backing.len(), then read
// THROUGH backing — realloc/clear cannot dangle it (worst case: clean
// out-of-bounds panic), reassignment of the original variable doesn't matter
// (the view's Rc keeps the object alive), alias mutation is VISIBLE (alias
// semantics, not snapshot).
```

- Cost model: copying a view = one Rc incref (the same cost the language
  already charges for any object-bearing struct). Access = one extra
  indirection + bounds check. NO CoW.
- Soundness: by construction — every access goes through the current buffer
  pointer; the Rc keeps the OBJECT alive; bounds checks catch shrunk lengths.
- Same pattern for `String` windows (`StrView` holding the String) if needed.

### 4. Flowability — shrinks back to its `ref(T)` core

With no raw-ptr-carrying values constructible in safe code:

- The slice-flow gates retire: value-return-carrying-raw-ptr (site 2), the
  raw-ptr assignment gates (sites 4, 5), `typeMayProvideSliceSource`, and the
  ctor/tuple raw-ptr arg rules become dead for safe code (they may remain as
  defense-in-depth for pragma'd code or be removed — decide during
  implementation).
- The `ref(name) : T` flowability (sites 1, 3; rules R1–R4) is UNCHANGED —
  it guards stack references, which still exist.
- `docs/{en-US,zh-CN}/FLOWABILITY.md` gets rewritten for the new model; the
  §Limitations entry about slice invalidation is DELETED (the hole is gone,
  not gated).

## Migration plan (ordered)

1. **`String == str`** (`Eq(str)` impl on String) + any missing
   `starts_with/ends_with/contains(str)` overloads. Land first — it makes the
   big mechanical migration possible. *(small)*
2. **Mechanical sweep**: `x.as_str() == …` → `x == …` across yo-self (2186
   sites, majority this shape), tests (84), std (6). Scriptable;
   per-directory sweeps with full validation after each. *(large but
   mechanical)*
3. **Audit the remainder**: bare `as_str()` uses that pass views to
   `: str`-typed parameters (11 such params in std) — flip the parameter to
   `String` (Rc share, cheap) or to a `str` literal where it really is
   static. *(moderate, case-by-case)*
4. **Delete builtin `Slice(T)`** (TypeTag + evaluator + codegen + prelude
   impls + `__yo_slice_*` builtins; `str` gets its own builtin fat-pointer
   lowering first) and remove `as_str`/`as_slice`; add `RawSlice(T)` to a
   pragma'd std file and migrate the pragma'd internals (imm/*, crypto,
   array_list, hash) to it; fix fallout in non-pragma'd tests (30 `as_slice`
   sites — many are the flowability tests themselves, rewritten per step 6).
5. **Add `ListView`** (+ `StrView` if needed) to std/collections with tests.
6. **Retire the slice-flow gates** (keep ref-core), rewrite
   `tests/flowability_comprehensive.test.yo` (ref-core + the new
   str-is-static positives + Slice-naming-gate negatives), update
   FLOWABILITY.md (both languages) and MEMORY_SAFETY.md's table.
7. **Full validation**: TS suite, yo-self sweeps (the evaluator port must
   stay green — the yo-self source itself is a step-2/3 migration target,
   2186 sites), CI matrix.

## Risks / open questions

- **Step 2 is the bulk**: yo-self IS the biggest consumer. Sweeps must be
  incremental with green validation between (the evaluator-port methodology).
- **`token.value` and friends**: yo-self's lexer/parser hold `String`
  everywhere and compare against literals — step 1+2 cover it; no redesign.
- **Heterogeneous `Eq`**: confirm parametric `Eq(str)` on String dispatches
  cleanly for infix `==` (the trait machinery supports `Eq(K)`; verify the
  operator-dispatch path picks the right overload vs `Eq(String)`).
- **`comptime_string` ↔ `str` coercions** in the evaluator: should SIMPLIFY
  (str = static is what the coercion paths already assume) — verify no path
  relied on str being heap-viewable.
- **C interop**: `*(char)("lit")` and extern signatures unchanged (pragma'd).
- **Codegen port interaction**: deleting the builtin REDUCES the codegen
  port surface (one less TypeTag/lowering family to port; 147 refs across 27
  src/ files retire). Order matters: give `str` its own builtin lowering
  BEFORE removing SliceType, since str currently lowers through it.
- **Array range-indexing**: decide drop-vs-view for runtime ranges during
  step 4; verify Array ELEMENT indexing doesn't lower through slice
  machinery (prelude `__yo_slice_index` is used by `*(Slice(T))` Indexable —
  check the Array element path before deleting).

## Status

- [x] 1. `String == str` + literal-overload std additions — DONE.
  `impl(String, Eq(str))` + `impl(str, Eq(String))` (direct memcmp, `(!=)`
  via the trait `?=` default) and the `StrPattern` trait on `String`
  (`contains`/`starts_with`/`ends_with`/`index_of`/`last_index_of`/`split`
  taking `str`; inherent methods cannot be overloaded, trait methods can).
  Two TS evaluator dispatch bugs fixed on the way (specializedType env
  mixing + first-match method shadowing) —
  `issues/fixed/heterogeneous-eq-overload-dispatch.md`. yo-self needs no
  port (registry returns all overloads; no specializedType). Validated:
  std 151/151 (TS + yo-self-bin), bun 459, string tests 249, impl tests 6.
- [x] 2. mechanical `as_str()` comparison sweep — DONE. Dropped `.as_str()`
  adjacent to `==`/`!=` (both sides; comment lines skipped): yo-self 1333
  sites / 96 files, tests 72 sites / 8 files (crypto/encoding/os), std 0
  (its 6 `as_str` uses are bare → step 3). Zero comparison-adjacent
  `as_str()` remains outside comments. Validated: full ./tests 2609/2609,
  swept-source yo-self-bin sweeps std 151/151 + tests 147/149 (baseline,
  2 circular fixtures) + yo-self 285/285.
- [ ] 3. remaining `as_str()` + `: str` param audit — IN PROGRESS.
  Done: (a) `String.from(x.as_str())` roundtrip → `x.clone()`, 250 sites /
  62 yo-self files (the stale clone-ambiguity lore is wrong — field
  receivers clone fine, cheatsheet fixed); (b) std safe-surface flips:
  `String.byte_at(i)` added (public byte indexer — the runtime-byte-access
  replacement for `as_str()`), `Url.parse`/`_parse_port` flipped
  `str`→`String` (callers wrap literals in `String.from`), base64 decode
  iterates `byte_at` directly, http client passes the String through.
  std now has 4 `as_str` uses, ALL in pragma'd privileged code awaiting the
  step-4 raw replacement: imm/string from_string + ToString (raw memcpy),
  assert_dyn/panic_dyn (builtin assert/panic take `str` msg — needs a
  step-4 decision).
  Batch 2 (committed): `Ord(String)` impl on String (byte-lexicographic,
  mirrors str's — `a < b` works directly) + yo-self helper-signature flips
  `str`→`String` with call-site as_str drops in: evaluator/exprs/match.yo
  (contains_str_in_list, find_str_in_list, _variant_name_eq,
  _is_gadt_branch_reachable + all variant-name locals), types/
  gadt_registry.yo (all enum_id params), types/enum.yo, exprs/import.yo
  (resolve_module_path), module_loader.yo (cache/loading paths), main.yo
  (normalize_import_path, collect_module_deps), build_runner.yo
  (execute_step, output-dir/name helpers, summary-tree prefixes),
  builtins/build.yo (all registry find_*/resolve_dependency name params).
  Lesson: when flipping a param, grep the body for `String.from(param)`
  materializations (→ `.clone()`) and literal callers (→ `String.from`
  wrap); match arms unifying with `""` need `String.new()`.
  Batch 3 (committed): registry-style `func_id : str` getters flipped to
  String across types/function.yo, types/macro_registry.yo,
  types/control_fn_registry.yo, function_value.yo (incl. copy_* helpers,
  get_func_where_constraints/validate_where_constraints_for_call chain);
  field-index/label helpers (find_first/last_field_index,
  _find_field_label_index, _find_field_index, _label_already_seen,
  _has_variant) + all their call sites; string_is_operator flipped with
  byte_at/bytes_len body conversion; generate_expr(s)_from_code; install
  append_dep_to_deps_file; `.push_str(x.as_str())` → `.push_string(x)`;
  `a.as_str() < b.as_str()` → `a < b` via the new Ord(String).
  Remaining: 47 non-codegen yo-self bare sites — mostly `local :=
  tok.value.as_str()` locals whose downstream uses need per-site review
  (formatter 7, install_command ~8 println-templates, expr.yo/
  expr_traversal locals, trait_checking, comptime_print, rc_fns/
  macro_expand IntLit-arm unifications) — plus ~600 codegen/driver/
  proto-eval (eval.yo) sites DEFERRED to the codegen port
  (plans/BOOTSTRAPPING_CODEGEN.md retires driver.yo, the untyped walker
  and the proto-evaluator; flipping their params first is wasted work).
  Standalone `./yo-cli check` on lock_file.yo/build_runner.yo fails with
  io.await/exists noise even when green — only the main.yo build verdict
  counts for those.
- [ ] 4. `Slice(T)` safe-code naming gate + remove `as_str`/`as_slice`
- [ ] 5. `ListView` library type + tests
- [ ] 6. flowability slice-gate retirement + docs/tests rewrite
- [ ] 7. full validation (TS suite, yo-self sweeps, CI)
