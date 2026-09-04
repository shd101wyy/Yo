# v0.2.15 evaluator regression: the if→cond desugar deep-cloned the source into every AST node

**Found:** 2026-08-22, when the manual v0.2.15 site deploy OOM-killed three
GitHub runners in a row ("The runner has received a shutdown signal", ~40-70s
into `yo compile scripts/build_site.yo` — severe memory pressure kills the
runner agent itself on 7 GB `ubuntu-latest`).

## Measurements (yo check of the vendor/markdown_yo import closure, M4 Mac)

| binary | wall | peak RSS |
| --- | --- | --- |
| v0.2.14 | 14.6 s | 2.7 GB |
| v0.2.15 (#199 content) | 50-60 s | 7.0-7.6 GB |
| #199 with the desugar DISABLED | 25 s | 3.5 GB |
| #199 with copy-on-write only | 56 s | 7.4 GB |

Bisect: the regression is entirely #199's parse-time `if`→`cond` desugar
(`desugar_program_if_calls`, plans/reference/MACRO_POLICY.md); the operator and
overloading merges are innocent. COW alone did NOT fix it — the dominant
cost was not the rebuild but the clones (below).

## Root cause — two compounding defects in `desugar_if_calls`

1. **Token deep-clones of the whole source.** `_synth_desugar_tok` built
   synthesized tokens with `ref_tok.input.clone()` (and
   `module_path.clone()`), and every construction site passed
   `tok.clone()`. `String.clone()` deep-copies its buffer, and
   `Token.input` is the ENTIRE SOURCE FILE — so every rebuilt node's token
   carried a private copy of the file. GB-scale memory on big modules, and
   allocation+memcpy of file-sized buffers throughout parse.
2. **The private copies then defeated the `__yo_ptr_eq` fast path** in
   String's `Eq`. `begin.yo`'s `_m3_tokens_comparable` compares
   `left.input == right.input` on the M3 early-return drop walk; with
   shared buffers that is O(1) pointer equality, with per-node copies it
   is a full-file `memcmp`. Profile (`sample`): 3,533 of ~8,300 samples in
   `_platform_memcmp`, 3,512 of them through ONE chain —
   `evaluate_begin_expression → _m3 walk → String ==` (v0.2.14 baseline:
   143 memcmp samples on the same workload).
3. (Minor, fixed alongside:) the desugar's fallthrough rebuilt EVERY
   FnCall node of every module even when no `if` existed beneath it.

## Fix (branch `perf/desugar-token-sharing`)

- `_synth_desugar_tok` and all desugar construction sites SHARE
  `module_path`/`input`/`tok` (plain field reads — copy semantics bump the
  RC handle; `.clone()` is for when buffer INDEPENDENCE is required, which
  a token never needs).
- Copy-on-write: `_contains_if_call` pre-scan (allocation-free); an
  if-free subtree is returned unchanged.

## Knock-on: `deploy-site.yml` gets a `builder` input

The v0.2.15 RELEASE binary keeps the regression forever, so the v0.2.15
site deploy would OOM 7 GB runners until v0.2.16. `deploy-site.yml` now
takes `builder` (default: `version`) so the site can be built by v0.2.14
while checked out at the v0.2.15 tag.

## Verification bar

- The measurement above back at ~v0.2.14 numbers.
- fmt idempotence + fixture corpus (desugar output unchanged in shape).
- gates_fast + fixpoint (the desugar feeds everything).
- The lesson for future AST rewrites: **never `.clone()` a Token or its
  `input`** — share; and any parse-time rewriting pass must be
  copy-on-write.
