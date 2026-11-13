# A `zip` or `enumerate` of borrowed cursors followed by `filter` is E0923 inside std

**Severity:** S2 — a valid iterator pipeline is rejected with an error located in std: `filter` over the `IterPair` that `zip` or `enumerate` yields from a borrowed cursor (`(&xs).into_iter()`) is E0923, so the pipeline has to be rewritten as a loop.

Found 2026-11-12 by the audit re-probe, pass 2 (`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md`; probes `probes2/it_zip`, `it_enumerate`). Already present on the audit tip `64f33c710`; v0.2.76 cannot spell a borrowed cursor, so this is not a release regression. `map`, `filter`, `fold`, `chain`, `take_while`, `skip_while`, `any`/`all`, `find`, a bound `next()`, and `for` over `filter` or over `enumerate` are all accepted over the same cursor.

## Reproducer

`issues/repros/2026-11-12-a-zip-or-enumerate-of-borrowed-cursors-followed-by-filter-is-e0923-inside-std.yo`:

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
mk :: (fn() -> ArrayList(String))({
  mut(xs) := ArrayList(String).new();
  xs.push(String.from("alpha-0123456789abcdefghijklmnopqrstuvwxyz"));
  xs.push(String.from("bb"));
  xs.push(String.from("gamma-0123456789"));
  xs
});
main :: (fn() -> unit)({
  xs := mk();
  ys := mk();
  n := (&xs).into_iter().zip((&ys).into_iter()).filter(p => (p.*._0.*.len() == p.*._1.*.len())).count();
  println(`OUT: ${n.to_string()}`);
});
export(main);
```

```text
$ yo check repro.yo     # develop 4f8f975b3
error[E0923]: Cannot assign a value holding origin `item` to `loop_result`: its type is declared over `Option(IterPair(A, B))`, whose origin does not name `item`, and a holder points only into the places its origin lists (decision 43, plans/backlog/REFERENCES_AND_ORIGINS.md O3).
```

`(&xs).into_iter().enumerate().filter(p => (p.*._0 > usize(0))).count()` gives the same E0923 over `Option(IterPair(usize, A))`.

## Cause (suspected)

`IterFilter`'s `next` (`std/prelude.yo`, `impl(…, IterFilter(I, F), Iterator(…))`) declares `(mut(loop_result) : Option(A)) = .None` and stores the accepted item with `loop_result = .Some(item)`. At the zip instance `A` is `IterZip`'s item type as spelled there, `IterPair(A, B)`, and that spelling names no origin: the pair carries the cursors' origins only through its type arguments. The O3 store check therefore sees a holder whose declared origin set is empty and rejects `item`'s origin. A bare `&String` item is a reference value (R3, #1904) and passes; a composite `IterPair` of references does not. Not bisected.

## Expected

Accepted, printing `OUT: 2` for the reproducer: `loop_result`'s type is the instance's `Option(IterPair(&(String, xs), &(String, ys)))`, whose origins name the cursors' places.

## Test

With the fix: the zip and enumerate pipelines as positive tests beside the iterator-adapter tests over borrowed cursors, and a corpus row.

## Cause, narrowed (2026-11-13, lane `sig`)

Not `filter`'s named `candidate` local: with the call itself as the scrutinee (`match(self._inner.next(), …)`, the
shape `find` uses) the same E0923 is raised. The value stored is `.Some(item)`, and `origin_of` gives the BY-VALUE
match binding `item` of an owned temporary scrutinee its own place as its root (the atom branch of `_origin_of_into`,
`src/evaluator/utils.yo`: no registered entries, not a parameter, so `_origin_push_place`). The subset check then
names `item`, which no holder type can. A reference item passes only because the read rule (R1) reads it back to the
scrutinee. The fix belongs to the binding: a by-value binding of a temporary scrutinee holds what the scrutinee
holds (R-CALL's roots), which is audit cluster 3's "a scrutinee that is a temporary" (lane `arms`, `match.yo` and
`origin_of`'s value positions). `find` over `zip` is very likely the same E0923 (same shape, not measured).
