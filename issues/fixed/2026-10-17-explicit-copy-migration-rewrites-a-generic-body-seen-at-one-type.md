# `yo fix --migrate explicit-copy` rewrites a generic body it saw at only one copying type

**Severity:** S2 — the migration turns a correct generic function or generic impl method into one that no longer evaluates for an instantiation whose type lacks `Clone`.

**Status:** fixed on `feat/v2b-genb-b1-migration` (V2b Generation B, step B1).

> Found 2026-10-17 running `yo fix ./std --migrate explicit-copy` for B1 of
> `plans/VALUES_BY_DEFAULT.md`'s Generation B sequence. The run rewrote
> `HashMap.get`'s `.Some(bucket.value)` into `.Some(bucket.value.clone())`,
> `ArrayList.extend`'s `self.push(other(i))` into `self.push(other(i).clone())`
> and `PriorityQueue.iter`'s `_data : self._data` into
> `_data : self._data.clone()`. All three are generic impl bodies.

## Symptom

The migration (#1385) leaves a generic body alone only when it records one
position at two different types. It records a site only when the copied type
is a `String`, a collection or a value holding one (`_ic_category_is_unique_buffer`).
So an instantiation at any other type leaves no record: a `ref` struct
(category `ref-object`) or plain data (no dup at all). A generic body that the
run evaluated at one buffer type therefore looks concrete, and gets
`.clone()`. That demands `Clone` of every instantiation.

## Reproducer

```yo
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
Node :: ref(struct(id : i32));
twice :: (fn(comptime(T) : Type, x : &T) -> ArrayList(T))({
  out := ArrayList(T).new();
  out.push(x);
  out.push(x);
  out
});
main :: (fn() -> unit)({
  s := String.from("a");
  xs := twice(String, &s);
  n := Node(id : i32(1));
  ns := twice(Node, &n);
  println(`${xs.len().to_string()} ${ns.len().to_string()} ${s}`);
});
export(main);
```

```console
$ yo check main.yo                                  # evaluator OK
$ yo fix main.yo --migrate explicit-copy
fix: inserted 2 `.clone()` call(s); 0 site(s) left as written (listed above); 0 file(s) did not evaluate
$ yo check main.yo                                  # fails: `twice(Node, &n)` now calls `.clone()` on a `Node`
```

## Root cause and fix

The "two types" test was the only generic-body guard, and it cannot see an
instantiation that records nothing. The fix marks each site with whether it
was evaluated inside a generic specialization
(`ctx.currently_specializing_function`, the state a `comptime`/`generic`
function or a generic impl method is specialized under):
`ExplicitCopySite.in_generic`, in `src/evaluator/utils.yo`. A generic body
that no call instantiates is evaluated only in its definition-time trial, at
an open type parameter (`PriorityQueue.iter` copies an `ArrayList(T)` there),
so a copied type that still mentions one (`type_contains_some_type_deep`)
sets the flag too. The driver (`_run_migrate_explicit_copy`, `src/main.yo`)
lists such a position and leaves it as written. These sites are B3's hand
edits.

The guard is deliberately conservative: a copy of a concrete-typed value
inside a generic body (a `String` field of a generic struct) would take a
plain `.clone()` safely, and is listed anyway. Most listed generic sites are
that shape, so B3's edit there is usually the `.clone()` itself, not a
projection.

Regression test: `tests/cli-cases/fix-migrate-explicit-copy-generic` (the
reproducer above plus an uncalled generic impl method; its `check` step and
its pinned tree fail before the fix).
