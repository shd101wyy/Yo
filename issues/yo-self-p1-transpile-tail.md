# yo-self P1 — executing-mode transpile-error tail (candidates)

## Status: OPEN — the P1 drain (lead, now that P0/corpus is deterministic)

Per-module `// Failed to transpile` markers, each a real executing-mode
evaluator/codegen gap. As of 2026-06-21 (after the Index-trait, cond/panic,
open-import, and P0 double-free fixes), the small/medium modules are near-clean:

| module | errors | family |
|---|---|---|
| `error.yo`, `token.yo`, `utils.yo`, `lexer.yo` | 0 | — |
| `expr.yo` | 2 | derived `Clone` in return pos; `match(...)` in return pos |
| `target.yo` | 2 | `cond(... => begin(... return ...))` as `:=` RHS; enum-ctor in return |
| `naming_checker.yo` | 1 | big `cond`/`while` (string `index_of`) in return pos |
| `value.yo` | 9 | mix (recursive `match` value-eq, `if(...)` in return, while-with-break) |
| `parser.yo` | ~8 | (mostly benign std/string begin-block arms + macro array_list) |

The big modules (`function.yo`, `match.yo`, `helper.yo`, `codegen_c.yo`, async)
still OOM on standalone compile — their tail is reachable only after the P2
memory work or on a 32 GB+ box.

## Candidate 1 — derived multi-field `Clone` — ✅ RESOLVED (4-layer fix)

Root-caused as FOUR stacked yo-self-only codegen bugs (not the suspected
generate_other_function_call constructor-callee gap below). All fixed; see
`yo-self-derive-clone-typename-quote.md` for the overview, plus
`yo-self-anon-fn-ref-param-deref.md` and `yo-self-method-inline-ref-amp.md`:
(1) `Type.to_comptime_string` stored an unquoted StrLit → corrupted constructor
head (Token->oke, T->empty); (2) `ref(self)` field reads not dereferenced
(anon-fn binding dropped is_ref); (3) derived enum clone re-materialized its
`ref(self)` match subject into a colliding local `self`; (4) a primitive field's
inlined `__yo_return_self` receiver was not address-of'd. Regression tests
`derive_clone_enum_string.yo` (non-primitive) + `derive_clone_multifield.yo`
(primitive) in the corpus.

### Original (now-disproven) hypothesis + repro

```rust
open(import("std/string"));
K :: enum(A, B);
derive(K, Clone, Eq(K));
T :: struct(kind : K, value : String, row : usize, col : usize, ch : usize, mp : String, inp : String);
derive(T, Clone);
mk :: (fn() -> T)(T(kind : K.A, value : String.from("v"), row : usize(1), col : usize(2), ch : usize(3), mp : String.from("m"), inp : String.from("i")));
main :: (fn() -> unit)({ a := mk(); b := a.clone(); () });
export(main);
```

yo-self emits, in T's derived clone body:
```c
return // Failed to transpile (((self.kind).clone)(), ((self.value).clone)(), …);
```
i.e. a struct construction whose **callee renders empty** (positional
`(field.clone(), …)`, no `T` head). An EXPLICIT labeled `T(kind : …, …)` (as in
`mk`) transpiles fine — only the derive-generated positional/`Self(...)` form
fails. This is the real `expr.yo:fn_..._6604` (Token's derived clone, rendered
`oke(...)`) and affects every `derive(Clone)` multi-field struct used in return
position (Token, AST nodes, …).

Likely root: yo-self's `generate_other_function_call` value-struct-constructor
branch doesn't recognize the derive-synthesized constructor callee (an empty/
gensym atom or a `Self` form) the way it recognizes a named/labeled `T(...)`.
Compare how the evaluator annotates the derived-clone construction's ExprInfo
(`value` = StructVal shell + `runtime_arg_exprs_in_order`) vs an explicit
labeled construction, and route the synthesized form through the same
runtime-construction emitter.

## Candidate 2 — ✅ RESOLVED (evaluator side): recursive-enum self-shell in nested match

`expr.yo` `is_function_boundary_arrow` is FIXED (expr.yo transpile errors 1→0).
Root: it does `match(func_box.*, …)` two levels into `AstExpr` (`func : Box(Self)`).
The enum self-shell patch (types/enum.yo) replaces only ONE level of self-nesting;
the second-level `Box(Self)` deref surfaced the raw empty-variant shell, and the
match evaluator never called `resolve_enum_shell` → "variant Atom not found in
<enum:..._self_shell>" → swallowed at def-time → no ExprInfo → "Failed to
transpile". Found by instrumenting `_trial_eval_fn_body`'s swallow to print
`err.to_string()`. Fix: `resolve_enum_shell(matched_type)` in match.yo (mirrors
synthesizer.yo / property_access.yo). check ./std 152/152, corpus PASS 82.

SIBLING (codegen, OPEN): the same self-shell leaks into C type emission — a
recursive enum's `Box(Self)` field emits an empty C enum ("use of empty enum").
See `yo-self-codegen-recursive-enum-self-shell.md` (repro + fix plan). Likely a
fixpoint blocker (AstExpr is itself a Box(Self) recursive enum).

`naming_checker.yo` / `value.yo` remaining failures are a DIFFERENT root — the
arm-frame-depth check (evaluator/utils.yo:711, "Frame level is different for
different cases") thrown for `cond`/`match` arms with non-uniform nested
control flow. Separate from the self-shell.

## Candidate 3 — `cond`/`begin` with an embedded early `return`, used as `:=` RHS

`target.yo:3389` (`abi := cond(... => begin(parsed := …, match(parsed, .None =>
begin(return(Err(...)), ()), .Some(v) => …)))`). Related to the OPEN
`issues/yo-codegen-block-rhs-drops-statements.md` ("block-RHS drops statements"):
a `{ stmt; value }` / control-flow expression as an assignment RHS.

## Method

`compile <m>.yo --emit-c --skip-c-compiler` + `grep -c "Failed to transpile"`;
minimal repro in `src/tests/fixme.yo`; if the node has no ExprInfo, instrument
the def-time trial-eval swallow (`_trial_eval_fn_body`,
`evaluator/calls/function_type.yo`) to print the swallowed throw; root-cause →
fix evaluator or emitter → re-measure → corpus-validate (now deterministic) →
commit. The corpus differential is reliable again post-P0.
