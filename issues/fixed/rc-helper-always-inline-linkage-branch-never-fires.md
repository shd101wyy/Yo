# The RC-helper `always_inline` linkage branch never fires (dead predicate)

**Status: FIXED 2026-08-23** by removing the arm from BOTH emitters
(`src/codegen/functions/generation.yo` and `declarations.yo` — they must agree
or a prototype/definition mismatch is "static declaration follows non-static"
at every call site).

Refinement on the analysis above: the arm is not strictly UNREACHABLE, which is
a better reason to delete it than the one first filed. A specialization's
signature folds every non-alnum byte to `_` and joins parts with `_`
(`compute_compile_time_signature`), so a mangled name CAN land on the
triple-underscore shape by coincidence — meaning the arm decorated whichever
arbitrary function happened to mangle that way, rather than the RC helpers it
was written for. Empirically it fires for nothing: zero code-position
`always_inline` in a 143 MB self-emission and in the suite batch emissions. And
dropping the attribute can only relax, since `always_inline` on a function
clang cannot inline is a hard error.

Evidence the change is inert: emitting a program that exercises none of the four
fixes landed together is BYTE-IDENTICAL before and after. (The compiler's OWN
emission necessarily differs — the deleted source text includes the
`"static inline __attribute__((always_inline)) "` literal, which was itself one
of the only two occurrences in the emission.)

No test: a linkage assertion on generated C would be brittle, and the
byte-identity check above is the stronger evidence. `_ca_is_rc_helper` in
`src/codegen/chunk_assembly.yo` keeps the same dead predicate deliberately —
`plans/reference/CHUNKED_C_EMISSION.md` defers it and the chunk-assembly unit test feeds
it synthetic names.

## What the code intends

Both the function-body emitter and the prototype emitter special-case
"reference-counting helper" functions and give them the strongest inlining
linkage available:

- `src/codegen/functions/generation.yo:434-435`
  ```rust
  is_rc := (!(is_exported) && ((c_function_name.contains("___drop")) || ((c_function_name.contains("___dup")) || (c_function_name.contains("___dispose")))));
  linkage := if(is_exported, String.from(""), if(is_rc, String.from("static inline __attribute__((always_inline)) "), String.from("static inline ")));
  ```
- `src/codegen/functions/declarations.yo:659-660` — the same predicate, so the
  prototype's linkage matches the definition's.

## What actually happens

The predicate tests for a **triple** underscore immediately before the verb
(`___drop`), but no emitted C function name ever has that shape. Verified
against a full self-build emission (`src/main.yo --release`, 143 MB,
~2.35 M lines):

| probe | result |
|---|---|
| `grep -c always_inline` | **2** — and both are the compiler's own string literals (`"static inline __attribute__((always_inline)) "`), i.e. the text this branch *would* emit. Zero emitted functions carry the attribute. |
| `grep -cE '___drop\|___dup\|___dispose'` | 66 — all string literals in the compiler's own source (`"___dup"`, `"___dup("`), never C identifiers |
| emitted RC-ish function names | `__yo_dispose___yo_dyn_box___yo_tN` (8 of them) — "dispose" is preceded by a SINGLE underscore (`__yo_dispose`), so `.contains("___dispose")` is false |

So the `is_rc` arm is unreachable and every generated function gets the plain
`static inline ` linkage.

## Why the impact is nil today

RC drops are not lowered through per-type helper functions at all — they are
lowered as **direct calls to the universal primitive**: the same emission
contains **336,211 `__yo_decr_rc(` call sites** and 14,756 `__yo_incr_rc(`
sites, against only 8 per-type dyn-box dispose functions. There is
essentially no per-type RC helper population for the branch to optimize, so
correcting the predicate would change ~8 functions.

`__yo_decr_rc` / `__yo_incr_rc` themselves get `static inline` from their
runtime templates (`src/codegen/functions/gc_runtime.yo`), not from this
branch, so the hot path is unaffected.

## Fix directions

1. **Remove the dead arm** (and the matching one in `declarations.yo`), leaving
   one `static inline ` linkage for all non-exported functions. Smallest
   change, removes misleading intent. The two emitters MUST stay in sync — a
   prototype/definition linkage mismatch produces "static declaration follows
   non-static" at call sites.
2. **Or correct the predicate** to the real naming (`__yo_drop_`, `__yo_dup_`,
   `__yo_dispose_`) if the `always_inline` behaviour is actually wanted for the
   dyn-box disposes. Measure first: `always_inline` on a dispose function that
   is only ever reached through a stored function pointer (`header->dispose_fn`)
   cannot be inlined at the indirect call anyway, so this is likely a no-op.

Recommendation: (1). Discovered while auditing which symbols must be duplicated
into every chunked translation unit (`plans/reference/CHUNKED_C_EMISSION.md` — the
chunk assembler has an equivalent dead predicate, `_ca_is_rc_helper`, noted in
that plan for the same reason).

## Test to add with the fix

An emission assertion in `tests/internal/` (or a cli-case golden) that pins the
linkage of a non-exported generated function, so a future predicate change
cannot silently flip prototype and definition out of sync.
