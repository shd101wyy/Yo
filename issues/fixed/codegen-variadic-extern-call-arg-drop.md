# Codegen drops the variadic argument of an extern call (snprintf "%d", self)

## Status
OPEN — surfaced 2026-06-17 once the const-generic `Array.fill` blocker was fixed
(see `codegen-gap6-println-generic-fn-monomorphization.md`). `str` print/println
work end-to-end in the self-hosted compiler; **integer** `to_string` no-ops at
runtime because the `snprintf` variadic value argument is dropped.

## Symptom
`println(i32(7))` compiles cleanly under the self-hosted compiler but prints
nothing (TS prints `7`). The integer `to_string` (`std/fmt/to_string.yo`) lowers to:

```c
Array_uint8_t_24 buffer = (Array_uint8_t_24){ .data = { 0, ...24... } };   // OK (const-generic fix)
uint8_t __yo_addrof_tmp = buffer.data[0];
uint8_t* buffer_ptr = &__yo_addrof_tmp;
snprintf(((char*)(buffer_ptr)), 24ULL, "%d");      // BUG: missing the `self` value arg
```

The Yo source is:
```rust
buffer := Array(u8, _INT_BUFFER_SIZE).fill(0);
buffer_ptr := (&(buffer(0)));
unsafe(snprintf(*(char)(buffer_ptr), _INT_BUFFER_SIZE, "%d", self));   // 4 args
```
The 4th argument `self` (the variadic value for `%d`) is dropped → `snprintf`
writes an empty / garbage string → `String.from_cstr(buffer_ptr)` is empty.

## Minimal repro
```rust
// /tmp/q2.yo
{ println } :: import("std/fmt");
main :: (fn() -> unit)({ println(i32(7)); });
export(main);
```
`str` cases (`println("ab")`) work — only the variadic extern call is affected.

## Suspected root
The extern-call argument emission in `codegen/exprs/other_fn_call.yo` (or the
function-call arg loop) does not emit arguments past the declared fixed
parameters of a `has_variadic` extern `Func`. `snprintf`'s declared params are
`(*(char), usize, *(char))` + variadic; the 4th positional `self` is variadic and
gets dropped. Also note `&(buffer(0))` materialized the element into a COPY temp
(`__yo_addrof_tmp = buffer.data[0]; &__yo_addrof_tmp`) instead of `&buffer.data[0]`
— a secondary issue (snprintf would scribble into a temp), but the primary blocker
is the dropped value arg.

## Next steps
1. Find where variadic args are (not) appended in the extern/regular call arg
   emission; ensure args beyond the fixed param count are emitted for a
   `has_variadic` callee.
2. Check the `&(buffer(0))` → `&buffer.data[0]` lowering (avoid the copy temp).
3. Add a corpus fixture (`println(i32(...))` differential) once fixed.

Validate: `/tmp/q2.yo` self-bin output `7` matching TS, corpus + std sweep + tests.

## Localization (2026-06-17)
- Codegen emits ALL recorded args: `generate_other_function_call` (other_fn_call.yo
  :1083) iterates `na = runtime_args.len()` and the extern "c" path (:1110-1136)
  emits `args_list` verbatim — no truncation to param count. So the drop is
  UPSTREAM: the evaluator recorded only 3 entries in `runtime_arg_exprs_in_order`.
- The inline FuncVal-arm arg loop (function.yo:1760 `while(ai < n_a)`) iterates ALL
  call args and pushes each to `runtime_arg_exprs` (the 4th/variadic arg's expected
  type is just `.None` from `fv_param_types.get(3)`), so THIS path would record all 4.
- => `snprintf(...)` inside the SPECIALIZED `to_string` body must reach a DIFFERENT
  evaluation arm that records only the fixed args. NEXT: instrument which call arm the
  extern `snprintf` call takes during the specialized-body re-eval (helper.yo
  create_specialized), and where the variadic arg is excluded from
  `runtime_arg_exprs_in_order`. Candidate arms: the extern-specific path, or a
  has_variadic-aware arg loop that stops at the declared param count.
