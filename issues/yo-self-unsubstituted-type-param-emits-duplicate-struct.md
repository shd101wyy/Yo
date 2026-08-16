# yo-self emits a duplicate C struct for an UNSUBSTITUTED type parameter, producing type-incorrect C

**Status: OPEN, root-caused 2026-08-16.** Surfaced by the converted
`test-wasm32_wasi` leg (PR #127), but it is **neither wasm-specific nor caused
by that conversion** — see the A/B below.

## Symptom

`tests/derive_clone_complex.test.yo` emits C that assigns between two distinct
struct pointer types:

```
error: incompatible pointer types initializing '__yo_t42 *'
       with an expression of type '__yo_t53 *' [-Wincompatible-pointer-types]
error: incompatible pointer types returning '__yo_t42 *'
       from a function with result type '__yo_t53 *'
```

Five such diagnostics. Under emcc 6.0.6 (CI) they are **errors** and the batch
fails to compile. Under clang 21 / emcc 4.0.12 (this machine) they are only
**warnings**, the binary links, and all 15 tests pass — which is why no native
job has ever caught it.

`-Wincompatible-pointer-types` became an error by default in clang 16+ and
GCC 14+, so this is a latent landmine on modern toolchains generally, not just
a wasm problem. It is the same family as the GCC blocker fixed in #130.

## Root cause

Three C structs are emitted for `Box`:

| C struct   | Yo type                         | correct?                       |
| ---------- | ------------------------------- | ------------------------------ |
| `__yo_t22` | `Box(i32)`                      | yes — concrete                 |
| `__yo_t42` | `Box(<enum:enum_decl_58624_…>)` | yes — concrete                 |
| `__yo_t53` | **`Box(V)`**                    | **no — `V` never substituted** |

`__yo_t42` and `__yo_t53` have **byte-identical bodies**:

```c
struct __yo_t42_struct { // Box(<enum:enum_decl_58624_…>) (reference counted)
  __yo_ref_header_t header;
  __yo_t41 _u42_;
};
struct __yo_t53_struct { // Box(V) (reference counted)
  __yo_ref_header_t header;
  __yo_t41 _u42_;
};
```

The generic type parameter `V` reached codegen unsubstituted and was given its
own C type. Everything typed `Box(V)` then disagrees with everything typed
`Box(<enum…>)`, even though they are the same type. Exactly one such leak is
present in this file (`grep -c 'struct __yo_t[0-9]*_struct { // .*(V)'` → 1).

## A/B — it is pre-existing, and it is a yo-self divergence

Same file, `tests/derive_clone_complex.test.yo`:

| compiler / binary                    | target     | diagnostics |
| ------------------------------------ | ---------- | ----------- |
| yo-self, target-aware builtins       | wasm-wasi  | 5           |
| yo-self, target-aware builtins       | **native** | **5**       |
| yo-self, BEFORE the target-aware fix | wasm-wasi  | 5           |
| **TypeScript compiler**              | native     | **0**       |

So: not wasm-specific, not introduced by the `get_current_target` change, and
TS resolves `V` correctly. TS is the reference implementation to diff against.

## Why it matters

- **It blocks the wasm legs.** They cannot go green until this is fixed, and
  those legs are the last Group D item gating `src/` deletion.
- **It affects native emission too.** Every native build of this shape already
  emits type-incorrect C; only the toolchain's leniency hides it. As CI images
  move to clang 16+/GCC 14+, previously-green jobs will start failing.
- **v0.2.7 is NOT affected — verified, not assumed.** Every shipped artifact is
  emitted by the TypeScript compiler: the seed used for all five bundles
  (`release.yml:342`), the portable `yo.c` arms (`:408`) and the musl bundle
  (`:482`) all run `node ./out/cjs/yo-cli.cjs`, and TS emits zero of these
  diagnostics. **The deadline is Group E**: deleting `src/` makes `yo-self` the
  release emitter, at which point this bug ships to users. It gates `src/`
  deletion, not the release already cut.

## Reproduce — 16 lines, `issues/repros/unsubstituted-box-typaram.yo`

The trigger is narrower than the whole test file: a **recursive enum with
`Box(Self)` fields plus `derive(Clone)`**. `Box`'s own type parameter is named
`V` (`std/prelude.yo:7382`), and that `V` is what leaks.

```rust
TreeNode :: enum(
  Leaf(value : i32),
  Branch(left : Box(Self), right : Box(Self))
);
derive(TreeNode, Clone);
```

```bash
<stage1> compile issues/repros/unsubstituted-box-typaram.yo --release --emit-c --skip-c-compiler -o /tmp/r
grep -cE '^struct __yo_t[0-9]+_struct \{ // Box\(V\)' /tmp/r.c
```

| compiler | Box structs emitted                                                    | `Box(V)` count |
| -------- | ---------------------------------------------------------------------- | -------------- |
| TS       | 1 — `Box(enum(Leaf(value: i32)))`, fully substituted                   | **0**          |
| yo-self  | 2 — the correct `Box(<enum:enum_decl_…>)` **plus** a spurious `Box(V)` | **1**          |

Full-file form (5 diagnostics):

```bash
YO_KEEP_BATCH=1 YO_STD=$PWD/std <stage1> test ./tests/derive_clone_complex.test.yo --parallel 1
grep -c 'incompatible pointer types' <log>          # 5
```

## Where to look

The substitution should have replaced `V` before the C type was named. Likely
sites: the specialization path that records a type's C name, and the
`type_key`/type-registry lookup that decides whether a type already has an
emitted struct — a `Box(V)` key and a `Box(<enum…>)` key must not both be
live. Related prior art: yo-self side tables going stale under substitution,
and shallow-vs-deep type predicates (`type_contains_some_type` is top-level
only while TS's recurses) — both have produced this class of miss before.
