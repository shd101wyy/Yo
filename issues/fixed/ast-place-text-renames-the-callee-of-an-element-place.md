# `ast_place_text` renamed the callee of an element place (`&xs(i)`)

**Severity:** S2 — a valid `&xs(i)` argument in a body evaluated more than once (a generic, comptime-specialized or closure-taking function) was rejected with `Variable "xs(i)(i)" not found.`

> Found 2026-10-10 by the marker sweep (plans/VALUES_BY_DEFAULT.md V3b,
> branch feat/vbd-v3b-marker-sweep): `std/collections/array_list.yo`'s
> `binary_search_by` became `cmp(&self(mid))` and every module importing it
> failed. **FIXED same day.**

## Reproducer

```rust
{ ArrayList } :: import("std/collections/array_list");
is_one :: (fn(imm(v) : i32) -> bool)(v == i32(1));
first_is_one :: (fn(imm(xs) : ArrayList(i32), comptime(k) : i32) -> bool)(is_one(&xs(usize(0))));
main :: (fn() -> unit)({
  xs := ArrayList(i32).new();
  xs.push(i32(1));
  _b := first_is_one(&xs, i32(3));
});
export(main);
```

```
error[E0401]: Variable "xs(usize(0))(usize(0))" not found.
```

The same body in a function evaluated once (no generic, comptime or
`Impl(Fn)` parameter) checked clean, and so did `&p.m(i)` (a field before the
element).

## Root cause

`apply_call_site_borrow_markers` computes the place's text for its
diagnostics (`ast_place_text`, `src/expr.yo`) for every marker argument. For a
call-shaped place it did

```rust
out := recur(pf);      // a name: the callee token's own `value`
out.push_str("(");
```

`recur(pf)` on an atom returns the token's interned `value` String, which is
still an implicitly copyable kind (shared buffer, V2b): `out` shared that
buffer and `push_str` wrote in place, with no uniqueness test. The callee
atom `xs` in the AST was renamed to `xs(usize(0))`. The first evaluation was
unaffected (the place was already evaluated by then); the next evaluation of
the same node (the per-call specialization of the body) looked up a variable
named `xs(usize(0))`.

## Fix

`ast_place_text` builds the call text in a fresh buffer
(`out := String.new(); out.push_string(recur(pf))`). Test:
`tests/parameter_modes.test.yo` ("&xs(i) lends an element from a body
evaluated per specialization", both the comptime-specialized and the
closure-taking shapes).

The hazard is the general V2b one — mutating a String obtained from a token or
another value shares its buffer until `String` is a unique-buffer value — so a
new `push_*` on a String returned by a helper should start from `String.new()`
or `.clone()`.
