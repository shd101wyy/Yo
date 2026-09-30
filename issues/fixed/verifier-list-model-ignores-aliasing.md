# Verifier: the ArrayList model gives each name its own list, so a mutation through an alias proves false contracts

**Severity:** S1 — `yo verify` reported `ok` for contracts that are false at runtime (a false proof) whenever a mutated list had a second name.

- **Status:** FIXED on `feat/verifier-list-get-pop` (R1 slice 3 of
  `plans/backlog/ATS_STYLE_INDEXED_TYPES.md`, 2026-09-30).
- **Component:** `src/verifier/vc.yo` — the R1 list model (slice 2, #1048).

## Summary

R1 models `ArrayList(T)` as an SMT datatype value `(contents, len)` bound
to a NAME, and a `push`/`pop` rebinds that name. But `ArrayList` is a
`ref` type: two names can be one list. The rebinding updates one of them
and leaves the other's term as it was, so the verifier keeps proving facts
about the stale name.

## Reproducers (measured with the tree build of 9451f0bd7, before the fix)

`tests/spec/fixtures/negative/dml_list_alias_local.yo` — a local copy:

```rust
alias_push :: (fn(xs : ArrayList(i32), ensures(xs.len() == old(xs.len()))) -> unit)({
  ys := xs;
  ys.push(i32(1));
});
```

`yo verify` reported `ok`. At runtime `xs.len()` grows by one.

`tests/spec/fixtures/negative/dml_list_alias_params.yo` — two parameters
one caller can fill with the same list:

```rust
two :: (fn(a : ArrayList(i32), b : ArrayList(i32),
  ensures((a.len() == (old(a.len()) + usize(1))) && (b.len() == old(b.len())))) -> unit
)({
  a.push(i32(1));
});
```

`yo verify` reported `ok`. `two(xs, xs)` breaks the second conjunct.

## Fix

A function whose body mutates a list (any name in `ctx.mutated_names`)
is a subset error when a second name could be the same list:

- a list-typed local bound from anything but `ArrayList(T).new()` /
  `ArrayList(T).with_capacity(n)` (`ctx.list_alias_locals`,
  `_note_list_alias`), or
- a mutated list parameter alongside another parameter of the same list
  type.

Both rules are conservative (a copy of a fresh local is rejected too); an
alias-aware heap model is future work for the R2 lemma layer. The driver
test "a list mutation next to a possible alias ..." in
`tests/internal/verifier_list_len.test.yo` pins both fixtures as subset
errors.
