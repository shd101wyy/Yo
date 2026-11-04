# The move-only help text still recommends `ref(struct(...))`, the spelling #1707 warns about and v0.2.77 removes

**Severity:** S3 — wrong advice: a user who follows the help for E0901 writes a `ref(struct(...))` declaration, which #1707 already warns about and whose parse support v0.2.77 deletes, so the suggested fix becomes a hard error two releases later.

Found by the README example-project rehearsal for v0.2.75 (http_server_demo_yo, a `TcpStream` captured by an `io.async` closure); present on develop d76eac577.

## What the user sees

```text
error[E0901]: use of moved value: the closure captures `stream`, whose type `TcpStream` is move-only, …
help: `stream` is move-only (…): move it (`sink(stream)`), lend it to a `&mut T` parameter, or share it through a reference type (`Rc`, `Arc`, a `ref(struct(...))`). …
```

The same advice is emitted for every move-only type that is copied (`… or share it through a reference type (\`Rc\`, \`Arc\`, a \`ref(struct(...))\`)`).

## Where the text lives

Live diagnostics (each one is printed to users):

- `src/evaluator/utils.yo:613` and `:701`: the two E0901 move-only help builders quoted above.
- `src/evaluator/types/struct.yo:303`: the recursive value struct error says "Make it 'ref(struct(...))', or route the recursion through a reference type (ArrayList, Rc, Option of a ref)". Since the values-by-default flip, `ArrayList` is a value type, so that alternative is wrong as well; the indirection is `Box`/`Rc`.
- `src/evaluator/trait_checking.yo:2385`: "a reference type (ref(struct(...)), ref(enum(...)) or their atomic(...) forms) may implement it".
- `src/diagnostics_registry.yo:463/464` (`yo explain` for the move error) and `:718/719` (the `Rc` payload write), in English and Chinese.

The user docs carry the spelling too (`grep -rl 'ref(struct(' docs/en-US` lists 11 files), and so does the E0909/E0920-era registry text that explains `.*` (`:733/734`).

## Recommendation

Rewrite the advice per VERDICTS-18 §C's user form ("is it written after construction? is it needed by two owners that outlive each other's calls?"): share through `Rc(T)` (read-only payload), `Rc(RefCell(T))` when the shared value is written, `Arc(Mutex(T))` across threads; keep `Box(T)` for recursion. Land it with the v0.2.76 ref-declaration migration, whose warning text (#1707) already names `Rc` as the replacement, so that every diagnostic agrees with the warning before the parser drops `ref` in v0.2.77. Update the cli-case goldens and the `diagnostics_registry_examples` test that pin these texts in the same change.
