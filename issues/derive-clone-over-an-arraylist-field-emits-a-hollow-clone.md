# derive(Clone) over a struct with an ArrayList field emits a hollow clone — fatal at runtime

**Severity:** S2 — the derived `clone` silently fails its definition-time trial, so standalone compiles fail at the C stage with a hard-to-read error and — worse — inside a larger program the hollow body ships and `abort()`s when `clone()` is first called; found 2026-09-29 landing the audit §3 `relatedInformation` work (`plans/LSP_AUDIT_2026-09-29.md`).

## Reproduction

`issues/repros/derive-clone-arraylist-field-hollow.yo`:

```rust
R :: struct(a : usize);
S :: struct(x : usize, rel : ArrayList(R));
derive(S, Clone);
main :: (fn() -> unit)({
  s := S(x : usize(2), rel : ArrayList(R).new());
  c := s.clone();
  println((s.x + c.x).to_string());
  ()
});
```

`yo check` passes. `yo compile` (v0.2.45 seed; the tree's own binary shows the
same) fails at the C stage:

```
error: call to 'fn_yo_id_1757584465273798055000000' declared with 'error' attribute:
yo: the body of fn_yo_id_... failed to transpile — its definition-time
evaluation failed and was swallowed (run yo check with YO_DEBUG_SWALLOW=1);
this call would abort at runtime
```

Inside the language server this shipped silently: `LspDiag` gained a
`related : ArrayList(RelatedInfo)` field, the build swallowed the derived
clone's failure, and the first `didOpen` of a document WITH a diagnostic
died with exit `0xC0000409` ("reached fn …, whose body failed to
transpile"). Wrapping the field in `Option(ArrayList(R))` does NOT dodge it.

## Relation to the known family

This is the `ArrayList`-field variant of
`issues/fixed/derive-eq-clone-ord-over-a-fixed-size-array-field-aborts-at-runtime.md`
(`Array(T, N)` fields, fixed by giving the field types the operations the
derive rule calls for): the derive's definition-time trial over a field
whose type is a REF (`ArrayList` is an `object`) generates a body whose
trial fails, and the swallow ships a hollow fn. The loud C-level `error`
attribute exists — the gap is that `check` stays green and nothing points
at the derive site.

## Fix direction

Either the derive rule handles ref-typed fields (clone the ref holder, not
an element walk), or `check`/compile reports the swallowed derive trial AT
THE DERIVE SITE instead of shipping the hollow body.

## Workaround (what the LSP code does)

A manual `impl(LspDiag, Clone(clone : …))` that constructs the copy field
by field (`related : self.related.clone()`), plus `derive(RelatedInfo,
Clone)` for the plain element type, in `src/lsp/diagnostics.yo`.
