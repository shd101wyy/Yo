# The element-borrow sibling rule still rejects a value collection that cannot alias

**Severity:** S2 — a valid program is rejected, and std pays a clone to avoid it. A call that
lends one element of a collection `&mut` (`&mut xs(0)`) beside a BY-VALUE argument of a type that
can reach the collection's type (`other : ArrayList(String)`) is rejected with `could hold a
handle` even when the argument is a value collection that, after B8, cannot alias the lent
container.

**Status:** fixed 2026-11-02 in the follow-up PR to the B8 flip (VERDICTS-12 B8-Q2, branch
`vbd/b8-sibling-rule`). The `grow_beside` pin is now an accepted call. The json `insert` switch is
seed-gated: it waits for a seed that carries this fix (see "The std cost" below).

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");
grow_beside :: (fn(dst : &mut String, other : ArrayList(String)) -> unit)({
  mut(o) := other;
  o.push(String.from("grown"));
  dst = String.from("w");
});
main :: (fn() -> unit)({
  mut(xs) := ArrayList(String).new();
  xs.push(String.from("a"));
  grow_beside(&mut xs(usize(0)), ArrayList(String).new()); // rejected: "could hold a handle"
});
export(main);
```

Until the fix, `tests/ref_field_borrow.test.yo` pinned this as
`comptime_expect_error(grow_beside(&mut xs(usize(0)), ArrayList(String).new()), "could hold a
handle")`. After B8 the program is sound: the callee owns `other` (a fresh value list), so
growing it cannot reallocate `xs`'s buffer, and the `&mut` element stays valid. The two other
pins in that test stay rejected under the fix below: `&_ListBox` (a `&` to a struct that holds
the container's type) and the `_StrLists` owner lent through a second handle, plus a closure
capturing the container.

## The std cost

`std/encoding/json.yo`'s `insert` cannot spell `old := replace(&mut values(i), value);` (the
`value : JsonValue` argument's type reaches `ArrayList`, so the sibling rule rejects the
element borrow beside it). It clones instead — `old := values(i).clone(); values(i) = value;` —
one deep copy of the old entry per key overwrite.

That clone outlives the fix by one release. The compiler calls `JsonValue.insert`
(`src/context_command.yo` and others), so stage 1 of `yo build` evaluates its body with the
seed, and the v0.2.73 seed still rejects the `replace` spelling (measured 2026-11-02:
`yo check` on a caller of `insert`, with `--std-path` over the B8 tree, fails at
`json.yo:380` with "could hold a handle"). The switch is parked in
`plans/backlog/SEED_VERSION_AUTOMATION.md` ("the json `insert` moves its old value out") until
`SEED_VERSION` carries this fix.

## Cause

`_reject_if_container_reachable` (`src/types/flowability.yo`, the element-borrow sibling rule)
walks TYPE reachability from the sibling argument to the container's type: "it may be an alias"
(`tests/ref_field_borrow.test.yo`'s three genuine pins). That reasoning only holds for
handle/reference semantics. A flipped value collection has a unique owner, so a by-VALUE
argument of that type cannot reach the lent container; only edges through reference semantics
(a `&`/`&mut` of a `ref`-rooted place, a second handle to a `ref` root, a closure capture) can
alias it.

## Fix

The walk (`_type_may_reach_any_of`, `src/types/flowability.yo`) now carries a `via_ref` flag.
A type in the place's holder set counts as reached only when the path to it crossed a
reference-semantic edge, or when the type is itself a shared handle (`_is_shared_handle_type`:
a `ref` struct or enum, `Rc`/`Arc`, a cell handle, `Weak`/`ArcWeak`, whose copies all name one
object). The edges that set `via_ref`:

- the sibling's own parameter mode: an argument bound to a `&`/`&mut` parameter starts behind a
  reference, which may name the place's holder (`hold_beside(&mut xs(0), &b)` with
  `b : _ListBox` stays rejected);
- entering a shared handle (the `_StrLists` owner, passed by `&` or by value);
- a `Reference` field (decision 43 N2b holders). The walk had no `Reference` case before, so a
  holder of a `&` was never followed.

A type that does not count is still walked into: a value of a target type can hold a shared
handle to another one. A raw pointer is followed without changing `via_ref`: a value type's raw
pointer is the buffer it owns (the value-type invariant), and it carries no origin (decision
43). Otherwise `ArrayList`'s own `_ptr` would make every recursive value type (a `JsonValue`
holding `ArrayList(JsonValue)`) reach itself. A `Box` payload is owned and is followed the same
way. A value struct whose raw pointer unsafe code aims at the caller's container is outside the
safe-code contract the rule checks, so it is not pinned. Verdict: VERDICTS-13 §5 (Q1 = A). Function values, `Dyn`, open type variables
and `void` pointers still answer "may reach anything", and closures are still judged by their
captures. The `seen` set is keyed by `(via_ref, type)`.

The rule tracks the flips themselves: `is_reference_semantics` is what B9–B11 flip, so no
per-flip follow-up is needed.

Tests: `tests/ref_field_borrow.test.yo`:

- "an element borrow beside a value that owns a list of the container's type": `grow_beside`
  accepted, plus a by-value `_ListBox` and a `ref` owner's field;
- "an element borrow beside a recursive value that owns lists of the container's type": the
  json `insert` shape over a user enum;
- "an element borrow beside a value that can reach the container": `&_ListBox`, the
  `_StrLists` owner by `&` and by value, and a `_MixedBox` (`copy : ArrayList(String)`,
  `shared : Rc(ArrayList(String))`) stay rejected. The `_MixedBox` sibling beside an element of
  another `_MixedBox` pins that the walk continues into a hit that does not count. The closure and `&Dyn` pins are
  unchanged.
