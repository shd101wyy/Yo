# Gap-6: generic free-function monomorphization (`println` etc.)

**Status:** OPEN — the deep frontier. `println("hello")` compiles+runs under TS
(prints `hello`) but the self-hosted compiler emits a call to the UNSPECIALIZED
generic and skips its body → undeclared function.

## Repro

`/tmp/pln.yo`:
```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)(println("hello"));
export(main);
```
Self-hosted emits (main):
```c
yo_id_5545((void*)((__yo_str){ .ptr = (const uint8_t*)"hello", .len = 5 }));
```
`yo_id_5545` is the GENERIC println (param `T` erased to `void*`); it is never
defined (correctly skipped — a hard-generic, SomeT-bearing body), so the call is
to an undeclared function. There is NO specialized `println_str`. Also the
`(void*)(__yo_str){...}` cast is itself invalid C (struct → void*).

## Concrete finding 2026-06-17 (post the str/String/mutation fixes — corpus 52)

Probed `create_specialized_function_inline`'s call site in the FuncVal-arm
forall>0 spec block (function.yo:2410), printing callee/ret/spec_fid:
- **println (`yo_id_5545`) NEVER reaches function.yo:2410** — it does NOT go
  through the FuncVal-arm runtime-return specialization at all. (Earlier memory
  notes were contradictory on this; this is the current, post-fix state.)
- The generics that DO reach 2410 (`yo_id_3834`, `yo_id_3840`, ret a struct)
  come back with **`spec_fid == callee`** — i.e. `create_specialized` returns the
  ORIGINAL func id, not a fresh specialized one.

So two distinct questions for the next (focused) session:
1. **What path does `println("hello")` take?** It bypasses the forall>0 spec arm
   (function.yo:2365-2410). Candidates: the comptime route (function.yo:2149 —
   if println is a macro / `fv_is_macro`, or `all_args_are_types`), or it never
   reaches the FuncVal arm (resolved as something else). Probe the branch at
   function.yo:2149 and the arm entry, gated on the println call (ret = unit,
   forall>0). NOTE func ids are stable per-source, but confirm `yo_id_5545` maps
   to println in the probe build before gating on it.
2. **Why does `create_specialized` return `spec_fid == callee`** for the generics
   that reach 2410? If it's meant to mint a fresh specialized func id (TS
   `specializeFunction`) but returns the input, no monomorph is produced. Check
   create_specialized_function_inline (helper.yo ~900-1130) — does it register a
   NEW func id, or short-circuit-return the original when (e.g.) it judges the
   body un-specializable / over-CTFEs to unit?

## Background (from memory, prior sessions — pre-fix)

`println`'s body is `s := v.to_string(); s.as_bytes(); …` — runtime ops over the
type param. The historical diagnosis: `create_specialized` evaluates the body to
derive types but runtime ops over an `UnknownVal` v OVER-CTFE to `unit`, so the
specialization is unusable; the original generic is then collected+emitted and the
get_type_string SomeT path / skip kicks in. **3+ single-point fixes were tried and
FALSIFIED** (is_executing toggle; hard-generic emission skip — caused a silent
no-op; genericity-guard broadening — regressed std). The conclusion stood: the
real fix is making `create_specialized` resolve the runtime-op body's TYPES
(dispatch `to_string` on the bound type var) WITHOUT CTFE-executing it — a
substantial evaluator-architecture change (the runtime-vs-CTFE body type-derivation
TS does at definition time). Do NOT attempt codegen-side band-aids.

The new finding above (println bypasses 2410 entirely) means step 1 — locating
println's ACTUAL dispatch path — must come first; the create_specialized work may
be moot for println if it never reaches it.

## PRECISE LOCALIZATION 2026-06-17 (gated `println`-atom probes, 4 -O0 builds)

Traced `println("hello")` step by step (probes gated on `ast_expr_is_atom_of(
func_expr, "println")`, robust to id churn):
1. ENTERS evaluate_function_call. ✓
2. Reaches the comptime-vs-runtime branch (function.yo:2149) with
   `thier=false crc=false aat=false mac=false forall=1 ret=unit` → takes the
   RUNTIME (else) path. ✓ (Earlier "bypasses 2410" was a tail-5 artifact — it DOES
   reach the spec arm.)
3. Reaches the runtime-path out_rt + the `if(forall_names.len()>0)` spec block
   (forall=1). ✓
4. Reaches `before-create-spec` (n_forall_args=1, n_reg_args=1) — i.e. the line
   immediately before `create_specialized_function_inline` (function.yo:~2424). ✓
5. The probe IMMEDIATELY AFTER create_specialized does **NOT** fire.

⇒ **`create_specialized_function_inline` THROWS for println** — it does not return.
The exception unwinds past the call site (skipping the ExprInfo-recording that
would route codegen to a specialized `println_str`), so the GENERIC println is left
recorded → codegen emits a call to the unspecialized (void*-param) func → undeclared.

The throw originates at **helper.yo:1101** — create_specialized evaluates the body
with `evaluate_begin_expression(body, callee_env, ctx, true, exn)`, passing the
OUTER `exn`. println's body (`s := v.to_string(); …`) executes runtime ops over the
bound type var; that eval throws, and because the OUTER exn is used (not a swallowing
trial-eval wrapper like the def-eval-wall sites), it propagates out instead of being
contained.

### DECISIVE NEXT STEP (do this first next session)
CAPTURE THE EXACT ERROR thrown at helper.yo:1101 for println. Wrap that body-eval
(or the create_specialized call in function.yo, where `func_expr=="println"` is
gatable) in a local `Exception(throw: (err) -> { <print err>; <re-throw via outer
exn> })` and print the message. That error decides the fix:
- If it's a METHOD-RESOLUTION / type error (e.g. `v.to_string()` can't resolve for
  `v:str`, or a SomeT leak) → likely a targeted, faithful fix.
- If it's a genuine runtime-op CTFE failure (executing `to_string`'s
  ArrayList/malloc body over an UnknownVal) → the deep architecture change
  (type-derive the body without executing) the memory describes; do NOT band-aid by
  swallowing (the 3rd falsified attempt made println a SILENT NO-OP — a swallowed
  body-eval leaves a concrete signature but an empty/broken body).
Error-printing needs the dyn(Error) formatting (see how the def-eval-wall trial-eval
"SWALLOW: ..." prints, or format_error_message / the Error trait's message).

## ⭐ EXACT ERROR CAPTURED 2026-06-17 — REFRAMES Gap-6

Wrapped the create_specialized call (function.yo, gated on `func_expr=="println"`)
with `Exception(throw : ((e) -> { eprintln(`...${e.to_string()}`); unwind(make_err_expr()) }))`
(NOTE: a `->` handler can't capture outer runtime vars `exn`/`expr`; unwind must
return the enclosing fn's type = AstExpr, hence `make_err_expr()`; AnyError =
Dyn(Error), Error <: ToString so `e.to_string()` works). Output:

```
PROBE_PLN create_spec threw: Error: Cannot unify incompatible types: "i32" and "str"
```

**This is a TYPE-UNIFICATION error, not an over-CTFE / runtime-execution failure.**
The months-old memory diagnosis ("create_specialized over-CTFEs `v.to_string()`'s
ArrayList/malloc body → unit") is WRONG for the current code. Specializing println
for `T=str` throws because some sub-expression of its body unifies `i32` with `str`.
So Gap-6 (at least for println) is likely a SPECIFIC, tractable type bug — not the
deep evaluator-architecture change previously assumed.

println body (std/fmt/index.yo:8-20):
```rust
s := v.to_string();                  // v:str → str's ToString
str_bytes := s.as_bytes();
str_bytes_len := str_bytes.len();
cond((str_bytes_len > 0) => { str_bytes_ptr := str_bytes.ptr().unwrap();
       unsafe(fwrite(*(void)(str_bytes_ptr), usize(1), str_bytes_len, stdout)); },
     true => ());
unsafe(fwrite(*(void)(*(u8)("\n")), usize(1), usize(1), stdout));   // <- suspect
```
SUSPECTS for the `i32`/`str` unify: `*(u8)("\n")` (line 19 — casting a `str`
literal as a `*(u8)`; `*(u8)(...)` is a deref-cast and `"\n"` is a str fat-pointer),
or `v.to_string()` (line 9 — the ToString dispatch for `str`). `i32` is the default
for an unconstrained int/`u8`, so a u8/char vs str clash is plausible at `*(u8)("\n")`.

### DEEPER ROOT 2026-06-17 (continued): forall `T` inferred as comptime_str

Minimal repro `myp(forall(T), v:T, where(T<:ToString))` with body JUST
`s := v.to_string();` reproduces the IDENTICAL failure (`yo_id_5545` undeclared,
str-as-arithmetic) — TS prints fine. So it's `v.to_string()` during spec, NOT the
fwrite/`*(u8)("\n")` lines.

Traced the forall binding (function.yo:1855-1884): `T` is bound to `arg_info.ty` =
**comptime_str** (the literal "hello"'s type), NOT `str`. str's to_string is trivial
(`String.from(self)`, std/fmt/to_string.yo:195) and `String.from(str)` works in
plain main — so the i32/str unify comes from `v` being typed comptime_str in the
spec body: `v.to_string()` dispatches against comptime_str (→ comptime_int → i32),
clashing with str. There IS an existing comptime_str→runtime param coercion at
function.yo:2019, but its guard `!is_some_type(bind_decl_pt)` EXCLUDES forall params
(v:T, T a SomeT).

ATTEMPT (reverted — safe but INEFFECTIVE): coerce the forall inference so a
comptime_str value arg binds `T = TypeValue.Str` (function.yo:1865). Build clean,
corpus 53/53 (regression-free), BUT println UNCHANGED — emitted C still
`yo_id_5545((void*)(...))` (generic, void* param), 0 funcs take `__yo_str`. So
EITHER (a) println's `T` inference does NOT go through that loop (line 1865 — the
`param_type_names`-matching path; check whether println's T is bound via the
recv_type_args FALLBACK at 1890, or yet another path / where-clause), OR (b) `T` did
become str but create_specialized STILL throws (so no spec is recorded → generic
emitted). GOTCHA hit: `fa_infer_ty` is a local (move-semantics) — needs `.clone()`
at `box(...)` (the original `arg_info.ty` was a non-consuming field read).

### NEXT STEP (tractable)
Bisect println's body to the offending sub-expression: temporarily reduce the body
to just `s := v.to_string();` then add lines back, OR instrument synthesize/unify to
print the token when it throws "i32"/"str". Most likely a single mis-typed cast
(`*(u8)("\n")`) — once found, the fix may be a one-liner in std/fmt OR a codegen/eval
cast handling fix, NOT the deep architecture change. (User has OK'd editing std/ if
needed.) Re-validate: pln.yo → `hello` matching TS, corpus + std sweep.
