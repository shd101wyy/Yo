### 1. PERFORMANCE — measured, in progress

`check ./std` (evaluator-only proxy, ~87 s at session start) is now
**31.02 s — 2.82x faster**, from two commits:

| step                                   | min user | delta  |
| -------------------------------------- | -------- | ------ |
| baseline                               | 87.35 s  | —      |
| `920c2876d` TS match-place dup elision | 79.90 s  | -8.5%  |
| yo-self port + 2 hot predicates        | 31.02 s  | -61.0% |

**What actually mattered** (all of it measured, not reasoned):

- A `check ./std` performs **10.8e9 `__yo_decr_rc` + 9.2e9 `__yo_incr_rc`**
  calls and **1.64e9 frees**. Sampled return-address attribution
  (`scratchpad/patch_rc_attrib.py`) ranked the call sites; ~60% sat in
  three functions that all `match` on a FIELD.
- The dominant cost was not refcount ops but **allocation**:
  `ast_expr_is_atom_of` / `ast_expr_is_fn_call_of` built a whole String
  (`== String.from(value)`) to compare against a `str` — a malloc+free
  at ~2.9e9 calls. Two lines gave -61%.

**Dead ends — do not repeat:**

- `always_inline` fast path for `__yo_decr_rc`: **-4.7% for +140% binary**.
  Per-call overhead is not the lever.
- String `==` pointer fast path: no win (earlier round).

**Next lever (highest value):** 143 `== String.from(x)` + 15
`!= String.from(x)` sites remain, **concentrated in codegen**
(`codegen/exprs/inline_fns.yo` 46 — a ~46-arm `cond` allocating per arm
on every inline-fn dispatch — and `codegen/exprs/generation.yo` 26).
Scripted rewriter ready: `scratchpad/rewrite_string_from_cmp.py`
(scanner-based, handles parens inside string literals; unit-tested).
File list: 28 non-test files.

**IMPORTANT — measure the right thing.** `check ./std` is evaluator-only
and does NOT exercise codegen, so it under-measures the stage2 emit.
Measure a codegen round with a real emit
(`<s1> compile yo-self/main.yo --release --emit-c --skip-c-compiler`),
not the check proxy.

Then: `_attach_early_return_only_drop_to_returns` (13.9% / 1.5e9 calls)
— it walks the ENTIRE begin-block subtree once per early-return
variable, and nested blocks re-walk what inner ones already did, but the
walk only acts on `return`/`unwind` nodes. `Expr.$` already carries a
merged subtree control-flow summary (`expr.ts:248`), so an early exit
when neither `controlFlow.return` nor `.unwind` is set should prune most
of it. Stay conservative where `$`/`controlFlow` is undefined.
