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
