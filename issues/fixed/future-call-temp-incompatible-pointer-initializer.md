# Future-returning call temps initialized without the interface cast (clang 16+ C error)

**Found**: 2026-08-27, PR #309 run 3 — the windows-arm cross-emit leg failed
with `error: incompatible pointer types initializing '__yo_tN *' with
'_file____priv_temp_M_state_t *'`; the same emission is a WARNING on every
other leg (1–2 per affected batch). **Fixed**: same day, branch
`s3/async-combinators`.

## Mechanism

A trait-method THUNK (e.g. the `Reader` impl's `read` delegating to `File`'s
inherent method) declares its call temp with the STAMPED type — the future
trait INTERFACE struct pointer — while the delegated callee's prototype
returns its concrete state-machine struct:

```c
static inline __yo_t53* yo_id_9176(__yo_t20* self, uint8_t* buf, size_t size, __yo_t24 io) {
  __yo_t53* _file____priv_temp_11543 = yo_id_8585(self, buf, size, io);  // ← concrete SM*
  return _file____priv_temp_11543;
}
```

Concrete-SM* → interface* is the design's own conversion (every async SM
struct begins with the interface's prefix — see get_type_string's
FutureTraitT fallback comment), but C requires the cast to be SPELLED.
clang 16+ compiling C treats the bare incompatible-pointer initializer as a
hard ERROR; the windows-arm runner's clang is the first CI leg to do so.

This is the C21 family's residual: `awaited_future_c_type_override` fixed
the awaited-future channel, but the THUNK-tail temp is declared at method
decl arms that never consult it (the callee value is not resolvable at those
sites for trait-dispatched methods).

## Fix

`_future_init_cast(ei.ty, context)` in `src/codegen/exprs/other_fn_call.yo`:
returns `(<iface-type>)` for future-typed results whose C type is a pointer,
spliced into the initializer at the three method-call decl arms; the same
cast added at `return.yo`'s tail-temp sites and the unwind-path temp site,
and the arm-A decl now consults `awaited_future_c_type_override` before the
direct callee-body channel. Gate: `tests/async_generic_param_capture.test.yo`
compiles with ZERO -Wincompatible-pointer-types (was 2).
