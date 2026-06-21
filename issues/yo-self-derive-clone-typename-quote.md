# yo-self: `Type.to_comptime_string` produced an unquoted StrLit → derive(Clone)/ToString head corrupted

## Status: FIXED (pending corpus validation) — yo-self-only port bug; TS reference is correct

## Symptom

Compiling any program that `derive(Clone)`s (or `derive(ToString)`s) a struct and
calls `.clone()` on it fails to transpile under the self-hosted compiler:

```
static inline __yo_struct_..._T fn_..._clone(__yo_struct_..._T* self) {
  return // Failed to transpile (((self.kind).clone)(), ((self.value).clone)(), …);
}
```

The derived constructor's **head (the type name) is missing**: for a struct named
`T` the callee is empty; for `Token` the callee renders `oke`. TS compiles and runs
the same program correctly.

## Minimal repro

(Corpus regression test: `tests/codegen-bootstrap/derive_clone_enum_string.yo`,
which exercises this fix together with the `ref(self)` deref and enum-clone-match
fixes. The all-primitive-field variant below additionally needs the separate
primitive-`.clone()` receiver fix — see `yo-self-anon-fn-ref-param-deref.md`'s
follow-up — and is kept in the scratchpad until that lands.)

```rust
open(import("std/string"));
{ println } :: import("std/fmt");
K :: enum(A, B);
derive(K, Clone, Eq(K));
T :: struct(kind : K, value : String, row : usize);
derive(T, Clone);
mk :: (fn() -> T)(T(kind : K.A, value : String.from("hello"), row : usize(7)));
main :: (fn() -> unit)({ a := mk(); b := a.clone(); println(b.value); println(b.row.to_string()); });
export(main);
```

TS: prints `hello\n7`. Pre-fix yo-self: C error `expected expression`.

## Root cause

`derive(Clone)` builds the clone-method body as a comptime string and parses it:

```rust
type_name :: Type.to_comptime_string(T);                 // std/prelude.yo:6662
clone_body :: __s3(type_name, "(", __s2(cloned_fields, ")"));   // "T(self.a.clone(), …)"
... ((self) -> #(clone_body.to_expr())) ...
```

yo-self represents comptime strings as `EvalValue.StrLit`, and — matching the
lexer, which keeps the surrounding `"` in a string token's `value`
(`yo-self/lexer.yo:277,304`) — its StrLit convention is **stored WITH the
surrounding double-quotes**. The `+` concat / string-method shims strip the
first/last char to recover the inner text (`yo-self/evaluator/eval.yo:1325-1328`),
and `to_string`/`process.yo` wrap their output in quotes to honor it.

`evaluate_yo_type_to_string` (`yo-self/evaluator/builtins/type_fns.yo`) violated
the convention: it stored `EvalValue.StrLit(type_to_string(tv))` — the raw name
`"Token"` / `"T"` **without** the surrounding quotes. So every downstream
quote-stripping consumer ate the real first/last character:

* `Token` (len 5): `__s3` concat strips → `oke`, body parses to `oke(…)`.
* `T` (len 1): the concat's `(len < 2)` guard soft-fails → unknown → empty callee.

`type_to_string` itself is correct (returns the full `name`, used verbatim in
error messages); only this one StrLit construction dropped the quotes.

Confirmed empirically (existing binaries, no rebuild) with comptime asserts:
`Type.to_comptime_string(Token) == "oke"` PASSES, `== "Token"` FAILS;
`Type.to_comptime_string(T) == ""` PASSES — i.e. the value is the name minus its
first and last char. TS passes `== "Token"` / `== "T"`.

## Fix

`yo-self/evaluator/builtins/type_fns.yo` — wrap the type name in quotes before
constructing the StrLit, matching `process.yo`'s `__yo_process_platform`:

```rust
s := type_to_string(tv.*);
quoted := ((String.from("\"") + s) + String.from("\""));
out_info.value = Option(EvalValue).Some(EvalValue.StrLit(quoted));
```

TS uses a distinct unquoted `ComptimeStringValue` (`createComptimeStringValue`),
so this is a yo-self-only convention bug — no TS change.

## Blast radius (all corrected, none regressed)

`__yo_type_to_comptime_string` feeds only `__derive_clone` (prelude.yo:6662) and
`__derive_tostring` (std/fmt/to_string.yo:286). Both embedded the name into
synthesized source; both were latently producing the stripped name (e.g. a
derived `to_string` would print `oke(…)`), and both are now correct. The
primitive `.to_comptime_string()` methods use separate builtins and are
unaffected.

## The full `derive(Clone)` codegen chain (4 layers)

A working derived `clone` for a value struct needs four independent yo-self
codegen fixes, each exposed only after the prior one. This dossier is layer 1.

| # | Bug | File | Status |
|---|---|---|---|
| 1 | `Type.to_comptime_string` unquoted StrLit → corrupted constructor head | `evaluator/builtins/type_fns.yo` | ✅ fixed |
| 2 | `ref(self)` field read not dereferenced (anon-fn binding dropped `is_ref`) | `evaluator/values/anonymous_function.yo` | ✅ fixed (`yo-self-anon-fn-ref-param-deref.md`) |
| 3 | derived enum `clone` matches `ref(self)` → match subject re-materialized into a colliding local `self` | `codegen/exprs/match.yo` | ✅ fixed (isInoutAtom guard) |
| 4 | derived clone of a **primitive** field: inlined `__yo_return_self` receiver lacks the `&` (`(*((*self).x))` vs `(*(&((*self).x)))`) | inline-call receiver address-of | ⏳ pending |

Layers 1–3 make all `ref(self)` field reads and non-primitive `derive(Clone)` /
`derive(ToString)` work (`tests/codegen-bootstrap/derive_clone_enum_string.yo`).
Layer 4 (primitive fields) is the last piece; its all-primitive-field repro is
held in the scratchpad (`derive_clone_multifield.yo`) until it lands.

## Why it slipped past `check`

`check` never codegens function bodies, and the yo-self test suite runs the
yo-self sources under the (correct) TS compiler. The bug only manifests when the
*self-hosted binary* codegens a derived `.clone()` body — i.e. exactly the
codegen-bootstrap phase.
