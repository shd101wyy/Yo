# A verified `for` over a list needs a name for how far it has got

**Kind:** design question. **DECIDED 2026-09-30 (the user): option 1 now, option 3 with R2.** The misleading message is fixed: the evaluator's placement error now names `for` and points here, and so does the verifier's subset error. Filed 2026-09-30
by R1 of `plans/backlog/ATS_STYLE_INDEXED_TYPES.md` ("`for` over a list" is
R1's last shape).

## The question

`while` verifies through the havoc-invariant rule, and every list fixture
states its invariant over an explicit index:
`invariant(i <= xs.len(), out.len() <= i)`. `for(xs, (x) => body)` binds
only the element. An invariant that relates progress to the list (`out`
grew at most once per element) has nothing to name, so no useful invariant
can be written. Today, measured with a compiler built at `5101639ad`:

```rust
for(xs, (x) => {
  invariant(n <= xs.len());
  if(x > i32(0), { n = (n + usize(1)); });
});
```

fails evaluation with "'invariant(...)' must be the first statement of the
enclosing 'while(...)' loop body". The `for` macro expands to a `while`
whose body fetches the next element first, so the user's invariant is not
first. The verifier also rejects `for` outright ("for loop (write it as a
while with an invariant …)"). And `n <= xs.len()` would not be provable as
an invariant anyway: nothing ties `n` to how many elements have gone by.

## Options

1. **Keep `for` outside the subset** and point to the explicit-index
   `while` (what the fixtures do). Fix only the misleading message: name
   `for`, and say to use `while` with an index.
2. **A ghost count usable in a `for` invariant**, e.g.
   `invariant(n <= for_count(), for_count() <= xs.len())`. The macro places
   the user's invariant first in its expansion and binds a hidden counter
   that the verifier models as the index. It is a new spec builtin, so the
   evaluator must accept it. If invariants are asserted in runtime mode,
   the counter must also be real at runtime.
3. **Creusot's `produced`: a ghost sequence of the elements consumed so
   far**, e.g. `invariant(seq_len(produced()) <= xs.len(), ...)`. This is
   strictly more than a count: `filter`'s element-wise spec needs the
   prefix, not just its length. It needs R2's `seq_of` over lists to mean
   anything beyond its length.
4. **An indexed handle `for(xs, (i, x) => body)`.** This changes runtime
   semantics, and `(k, v)` already means a map entry.

## Recommendation

**Option 1 now, option 3 with R2.** A count-only ghost (option 2) is a new
language surface whose only job is to be replaced once R2 lands the
sequence layer. The prefix-consumed ghost is what `for` invariants actually
need. Until then the explicit-index `while` verifies every R1 example today
(`tests/spec/fixtures/valid/dml_list_zip_filter_reverse.yo`), so nothing
is blocked. The message fix is small and should land regardless.
