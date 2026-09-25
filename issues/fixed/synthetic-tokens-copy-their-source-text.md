# Synthesized tokens copied their module's whole source text

**Status: FIXED 2026-09-25** (`plans/EVALUATOR_MEMORY_REDUCTION.md` §0.12).

## Symptom

A holder census of `check src/main.yo` (exclusive shares, `HOLDER_DEEP_LAST`)
put 218 MB under `g_macro_expansions`. 216 MB of that was 14,559 `ArrayList(u8)`
buffers averaging about 15 KB, reached as
`g_macro_expansions → expr → expr → Token → ArrayList(u8)`. There were about three
buffers per token (4,853 tokens), so every expansion token owned private
copies of its strings.

## Root cause

A `Token` is an Rc object. The lexer gives every token of a module the same
`input` (the module's source text) and `module_path` handles, and `Token.clone`
is a refcount bump. Eleven sites that SYNTHESIZE a token from a source token
instead wrote

```rust
module_path : tok.module_path.clone(),
input : tok.input.clone()
```

and `String.clone` allocates and copies the bytes. Each such token therefore
carried its own copy of its module's entire source. The sites:
- `gensym`;
- the `begin` atom `match` builds for an arm's pattern tests (every such arm);
- the numeric and pointer conversion atoms (`try_to_convert_to_numeric_type`,
  `pointer_type.yo`);
- the `&` atom of a receiver method trial and of the method dispatch
  (`function.yo`);
- the pattern compiler's synthetic atoms;
- two contract sites;
- two formatter sites.

## Fix

The sites share the handles (`input : tok.input`,
`module_path : tok.module_path`), as the lexer and parser already do. Nothing
mutates a token's `input` or `module_path` in place (no `push`/`clear`/`truncate`
on either anywhere in `src/`). Both strings were already shared by every lexed
token of a module, so sharing them in synthesized tokens adds no new aliasing.

## Measured

See the plan's §0.12 for the A/B on `check src/main.yo` and the emitted-C
comparison.

## Test

`tests/internal/macro_helpers.test.yo`, "a gensym'd token shares its source
token's input": `evaluate_gensym` on a call whose token carries a known source
string; the synthesized atom's token must hold the SAME buffer (`__yo_ptr_eq` on
the byte lists) for `input` and `module_path`.
