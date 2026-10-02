# 5b: eliding a std container's own bounds check at a proved call site

**Status:** BACKLOG, design written 2026-10-02, not started. It answers the
second prerequisite of 5b Phase 3
([`SAFE_MODE_5B_VERIFIED_GUARD_ELISION`](SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md)
§7, the Phase 3 status note). The same plan's §1 lists std container bounds
checks as a non-goal "which is a different design": this is that design. It
pays off before Phase 3 too, because a verified ENTRY file's `xs(i)` on an
`ArrayList` becomes elidable.

## 1. The facts

- **The verifier already proves these sites.** It emits a sited
  `index-in-bounds` obligation for a list read, both `xs(i)` and the
  list-model path (`src/verifier/vc.yo`, the computed-callee branch and the
  list-model reads). So a verify-mode function over an `ArrayList` parameter
  can discharge `i < len(xs)` at each read today.
- **Codegen has nothing to drop.** Phase 1's elision works because the guard
  is a codegen-emitted helper: `_checked_index_expr` in
  `src/codegen/utils/index.yo` asks `guard_site_is_proved(expr,
  "index-in-bounds")` and drops `__yo_idx_chk`. An `ArrayList` subscript is
  instead a call to its `Index(usize).index` impl, and the trap is
  `if(idx >= self._length, { __yo_panic(...) })` inside std's body
  (`std/collections/array_list.yo`).
- **No inline facility.** Neither user nor std functions can be marked inline,
  so "inline the impl at the call site and let Phase 1 see the guard" is not
  available.
- **The gate shape is settled.** Safe code cannot hold a raw pointer result
  (the value gate), which is why std hands out storage as `*T`, never through
  a pointer-free struct (#1108, the #1076 precedent).

## 2. Options

**A. An unchecked twin, selected by codegen at a proved site (recommended).**
A second prelude trait, sketched:

```rust
IndexUnchecked :: (fn(comptime(Idx) : Type) -> comptime(Trait))(
  trait(
    Output : Type,
    /// The element at `idx` WITHOUT the bounds check. Only codegen calls
    /// this, at a site the verifier proved in bounds.
    index_unchecked : (fn(inout(self) : Self, idx : Idx) -> *(Self.Output))
  )
);
```

`ArrayList(T)` implements it with its existing body minus the length test.
When codegen lowers a subscript `xs(i)` whose receiver type implements
`IndexUnchecked(Idx)` with the same `Output`, and
`guard_site_is_proved(expr, "index-in-bounds")` holds, it calls
`index_unchecked` instead of `index`. Otherwise nothing changes.

- **Safety:** the method returns `*(Self.Output)`. A direct call from a safe
  file is rejected by the existing pointer-result value gate, the same
  reason `ArrayList.ptr()` is safe to expose. No new gate.
- **General, not hardcoded:** codegen keys on the trait, not on `ArrayList`.
  `Deque` and `String` can opt in the same way later.
- **Runtime files unchanged:** no verify pragma means no proved sites, which
  means the same C. That keeps the byte-identity gate (`--no-guard-elision`
  vs default over `src/`).
- **Cost:** one prelude trait, one impl per opted-in container, and one
  branch in the subscript lowering.

**B. Per-call-site specialization of the std body.** Emit a private copy of
`index` with the length test folded out at each proved site. Rejected: it
duplicates bodies per site, needs a new codegen pathway for "the same
function with one branch removed", and the result is A with worse code size.

**C. A codegen-visible guard builtin inside std.** std's body would call
`__yo_bounds_chk(idx, len)` and codegen would elide it "when the caller's site
is proved". Rejected: the guard's node lives in std's body, which is emitted
once for every caller, so a per-caller proof has no node to attach to.

## 3. Soundness

The 5b §5.1 filter applies unchanged. It decides at record time whether a
site is proved: function outcome `ok`, no unenforced assumption on the path,
a 64-bit target. A elides only what that table says is proved.

One addition: the twin must share `index`'s `Output`, and its body must be
`index` minus the length test. A container that implements `IndexUnchecked`
with a weaker body would turn a proof into UB. The impl is std-only today, so
review covers it. A follow-up could let the verifier walk both bodies and
check that they agree on in-bounds inputs.

## 4. Landing order and gates

1. **Language and std:** the prelude trait, `ArrayList`'s impl, a
   `safe_code_structural_gates` case showing that a direct
   `xs.index_unchecked(i)` from a pragma-less file is rejected, and the
   instruction and doc updates (yo-syntax, MEMORY_SAFETY in en + zh). Seed
   rule: std may use the trait at once, since it is plain Yo, but codegen's
   selection lands in the same PR, so the seed never sees a half state.
2. **Codegen:** the subscript lowering's selection, plus a new
   `tests/spec/fixtures/elision/arraylist_index_proved.yo` with an
   `// expect-elided: N` header, and a `…_kept.yo` twin where the bound is
   not provable. Gates: `scripts/check-guard-elision.py` (`N/N passed`);
   `src/` C byte-identical with and without `--no-guard-elision`; the fast
   suite.
3. **Measure:** one hot-loop microbenchmark over a verified `ArrayList` sum,
   guard vs no guard. Record it whether or not it wins (§1's
   performance-is-not-the-justification rule).

## 5. Not covered here

Phase 3's first prerequisite, std bodies the verifier walks rather than
`assumed()`, is separate work. `yo verify ./std/collections` measured
9 `assumed`, 3 outside-subset and 1 vacuous `ok` on 2026-10-01. This design
needs no change there: it elides at user call sites in verified files, and
Phase 3 would later extend the proved-site table to std's own callers.
