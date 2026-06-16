# Runtime enum construction in one match arm corrupts a sibling comptime arm's enum C-name

**Status:** OPEN. Surfaced 2026-06-16 by `ArrayList(u8).get()` iteration after the
single-expr-begin `runtime_arg_exprs` fix (commits 45583eea0 + 1fe76ab9f) made
runtime-payload enum construction (`​.Some((p &+ i).*)`) reachable.

## Repro

`/tmp/next1.yo`:
```rust
pragma(Pragma.AllowUnsafe);
{ ArrayList } :: import("std/collections/array_list");
{ putchar } :: import("std/libc/stdio");
main :: (fn() -> unit)({
  al := ArrayList(u8).new();
  consume(al.push(u8(65)));
  consume(al.push(u8(66)));
  consume(al.push(u8(67)));
  i := usize(0);
  while(i < al.len(), i = (i + usize(1)), {
    match(al.get(i), .Some(c) => unsafe(putchar(int(i32(c)))), .None => ());
  });
});
export(main);
```
TS prints `ABC`. self-hosted: C compile error.

The blocker is in `ArrayList.get`'s body (array_list.yo:209):
```rust
match(self._ptr, .None => .None, .Some(_ptr) => .Some((_ptr &+ index).*))
```
`self._ptr` is `?*(T)` → the match lowers via `_gen_nullable_ptr_match`. The
`.Some((_ptr &+ index).*)` arm is a RUNTIME enum construction (payload is a runtime
pointer deref) — it correctly emits via `_generate_runtime_enum_construct`:
```c
__yo_enum_yo_id_3755 _file____tmp__temp_1768 =
  (__yo_enum_yo_id_3755){ .tag = __YO_ENUM_YO_ID_3755_SOME,
                          .data = { .Some = { .value = (*(_ptr + index)) } } };  // CORRECT
```
But the SIBLING `.None => .None` arm (a COMPTIME enum value, emitted via
`generate_comptime_value`) then comes out CORRUPTED:
```c
_file____tmp__temp_1770 =
  (__yo_enum_yo_id_3755 _file____tmp__temp_1768){ .tag = __YO_ENUM_YO_ID_3755 _FILE____TMP__TEMP_1768_NONE };
```
The enum's C name `__yo_enum_yo_id_3755` has the SOME arm's RESULT TEMP
(`_file____tmp__temp_1768`) spliced in — making the cast type a malformed C
declaration `(<type> <var>)` and the tag `__YO_ENUM_YO_ID_3755 _FILE..._NONE`.

## What is established

- The corruption is INTRODUCED by routing the `.Some` arm through runtime
  construction. With the GATED begin.yo fix (45583eea0, before 1fe76ab9f) the
  `.None` arms are CLEAN (`(__yo_enum_yo_id_3755){ .tag = NONE }`) and only the
  `.Some` arm fails (`​.value = /* skip generating value */`). So it is the
  runtime-enum path in the sibling arm that pollutes, NOT a pre-existing `.None`
  bug.
- `generate_comptime_value` (comptime_value.yo:193) and
  `_generate_runtime_enum_construct` (other_fn_call.yo:591) BOTH build the c-name
  via `context.get_type_c_name(type_key(ty))`. The SOME arm read it CLEAN, the
  NONE arm read it POLLUTED → something WROTE a polluted entry for `type_key(3755)`
  between the two arm emissions.
- The polluted value is literally a C declaration string (`<type> <var>`), i.e.
  `get_type_string(ty) + " " + <tempvar>`. So a temp-variable DECLARATION emission
  for the SOME arm's result appears to register itself as the enum type's c-name.
- `get_type_string` / `type_key` themselves are side-effect-free (utils/index.yo:609,646).
- Corpus (48/48) and the std per-file sweep did NOT catch this — no fixture
  exercises `match(ptr, .None => .None, .Some(_p) => .Some(<runtime>))` (the exact
  get shape: a nullable-ptr match whose Some arm is a runtime enum construction and
  whose None arm is a comptime enum value of the SAME enum type).

## Next probe (one -O0 build)

Instrument `context.get_type_c_name` (and/or `register_type_c_name`) to `eprintln`
whenever a stored/returned c-name contains a space — print the key + value +
caller. That pinpoints the writer that stores `__yo_enum_yo_id_3755 _file____tmp__temp_1768`.
Prime suspect: the result-temp DECLARATION emission for a runtime enum
construction used as a match-arm value (the path that creates
`_file____tmp__temp_1768`), where the type string is being mis-registered as the
type's canonical c-name keyed by `type_key(3755)`.

Once fixed, `ArrayList(u8).get()` iteration (next1.yo) should compile + print
`ABC`; add it as a corpus fixture.
