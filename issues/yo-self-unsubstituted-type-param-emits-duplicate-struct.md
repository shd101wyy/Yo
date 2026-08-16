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

## MEASURED 2026-08-16 — the fix machinery already exists, runs, sees it, and fails to bind

yo-self's own source documents this exact symptom at
`yo-self/evaluator/types/function.yo:4772-4790`:

> "the gap is only in the MAP, so a forall occurring solely as an instantiation
> ARGUMENT is never a substitution key … a raw SomeT in an argument slot emits a
> SECOND C struct with the same layout"

`_collect_type_arg_somes` + `_resolve_type_arg_somes` were written for it and are
wired into `evaluate_function_return_type_again`'s exit (`function.yo:4976`).
Reading the collector confirms it _does_ walk `type_arguments` and push SomeTs.

**So the question was: does it not run, or does it run and fail?** Instrumented
stage-1 (`__DBG_TAS`) on the 16-line repro answers it:

```
enter count:            1683      _resolve_type_arg_somes DOES run
collected=1 ty=Box(V)   x13       it DOES collect the type-argument SomeT
bound_any=YES:          0
bound_any=NO:           13        every single attempt fails to resolve V
```

It is therefore **not** a missing call and **not** a blind collector. All three
documented resolution channels — env by name → the SomeT's own
`resolved_concrete` cell → the id-keyed `lookup_some_resolved_concrete` registry
— miss for this `V`, 13 times out of 13. Which channel _should_ have had it is
the next measurement (a per-channel probe is in flight).

### Corroborating detail from the emitted C

The specialized `box`'s mangled name encodes the **concrete** return
(`…_ret_R_gs_yo_id_2799_enum_decl_58427_…`), while its declared C type is
`__yo_t2*` = `Box(V)` (`/tmp/repro_self.c:414`). The specialization KEY resolved;
the emitted TYPE did not. Whatever populates the key had the concrete type in
hand at a point where the return TypeValue did not.

## Leading hypothesis for the next probe: two DIFFERENT SomeT instances for `V`

The measurement above looks self-contradictory at first, and the contradiction is
the clue:

- The two structs' **bodies are byte-identical** (`__yo_t0 _u42_` in both). The
  field's `V` therefore _was_ resolved — `get_type_string` lowers a SomeT through
  its `resolved_concrete` cell / the id-keyed registry, and
  `yo-self/codegen/functions/declarations.yo:416-428` documents exactly that
  ("a RESOLVABLE top-level wrapper SomeT is NOT generic for codegen").
- Yet `_resolve_type_arg_somes` reports **all three channels missing**, 13/13,
  for the `V` in the same type's `type_arguments` slot.

Both cannot be true of one object. So the `V` in the **type-argument slot** is
most likely a _different SomeT instance_ from the `V` in the **field** slot — a
copy whose own resolution cell was never populated and whose id therefore misses
in the id-keyed registry. `type_key.yo:127` already warns in this register: "an
unresolved chain keeps the ORIGINAL slot".

That also explains the env channel missing: `_resolve_type_arg_somes`'s first
channel is by name (`get_value_of_some_type_from_env`), so if the binding is not
in the callee env at this point, only the per-instance channels could have
helped — and they are attached to the _other_ instance.

**Next probe (cheap, one instrumented build):** print the SomeT `id` (and
name/level) for (a) the type-argument `V` reaching `_resolve_type_arg_somes` and
(b) the field `V` that `get_type_string` successfully resolves. If the ids
differ, the fix is to make type-argument resolution consult the same resolution
the field uses — keying on name+level rather than instance id, or sharing the
cell at the point the copy is made. If the ids are the SAME, this hypothesis is
dead and the registry population order is the thing to measure instead.

**Instrumentation note:** put probes at **function-body statement level**. An
`eprintln` inside a `match` arm whose sibling is a bare `()` fails the build with
`Frame level N has different number of values for different cases` — this cost
two build cycles (see `.github/instructions/yo-syntax.instructions.md`).

## A fix that must NOT be used

Swapping the deep `type_contains_some_type` predicate in at the emission site to
filter `Box(V)` is **actively harmful here**, not merely inelegant. That
`Box(V)` is the declared C return type of a real emitted function, so filtering
it makes `get_type_string` miss, the on-demand alias hook fall through (it
requires exactly one registered entry sharing the nominal id; this program has
two), and `_lookup_named_c_type` **panic** —
`"get_type_string: type not registered in context.types"`
(`yo-self/codegen/utils/index.yo:810-816`). Five clang diagnostics would become a
compiler abort.

Unifying the two types' _identity_ so they collapse onto one C struct is
likewise not the fix: it makes the symptom disappear while leaving a function
whose declared return type is a type parameter. Fix the resolution.

## Where to look

The substitution should have replaced `V` before the C type was named. Likely
sites: the specialization path that records a type's C name, and the
`type_key`/type-registry lookup that decides whether a type already has an
emitted struct — a `Box(V)` key and a `Box(<enum…>)` key must not both be
live. Related prior art: yo-self side tables going stale under substitution,
and shallow-vs-deep type predicates (`type_contains_some_type` is top-level
only while TS's recurses) — both have produced this class of miss before.
