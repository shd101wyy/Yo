# The cloned-accessors migration renames nothing over a move-only element

**Severity:** S2. Over the flipped std (B8), `yo fix --migrate cloned-accessors` reports "does not evaluate" for any `xs.get(i)` or `xs.first()` whose element is a `String` (or any move-only element) and renames nothing, so the migration cannot do the one job it exists for. v0.2.75 still ships every mode, and the README-project migration needs this one.

Found 2026-11-03 by v2c on `vbd/b8-arraylist-string-flip-r4`. Reproduced by B8 with `yo-tree-602936aa1` (the B8 tip's tree binary). The V2c binary behaves the same way.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  mut(names) := ArrayList(String).new();
  names.push(String.from("a"));
  names.push(String.from("b"));
  first := names.get(usize(0));
  second := names.first();
  match(
    (first, second),
    (.Some(a), .Some(b)) => {
      println(a);
      println(b);
    },
    _ => println(`none`)
  );
});
export(main);
```

`yo fix main.yo --migrate cloned-accessors --std-path <B8 std>` prints:

```
fix: main.yo does not evaluate; its accessor calls are migrated only as far as evaluation reached
fix: renamed 0 accessor call(s) to their `_cloned` sibling; 0 site(s) left as written (listed above); 1 file(s) did not evaluate
```

The file is left unchanged.

With the v0.2.73 seed and its bundled pre-flip std, the same command renames both calls (`get_cloned`, `first_cloned`). The pre-flip case still says "does not evaluate", because the rest of the program fails later, but the sites recorded before that failure are applied. The `tests/cli-cases/fix-migrate-cloned-accessors` fixture still passes only because B8 moved its element type to `BTreeMap`, which stays a `ref` handle until B10.

## Root cause

Since B8, specializing `ArrayList(String).get` is itself E0901: its body's `_ptr.add(index).*` copies a move-only `String` out of storage (``cannot copy `(_ptr.add)(index).*`, whose type `String` is move-only … a dereference copies, it never moves``). That error is raised in the `.Some(err)` arm of the method-call evaluation in `src/evaluator/calls/function.yo` (`_evaluate_function_call_trapped`, about line 8222), where it is rethrown at the user's call.

`_audit_copying_accessor_call`, which records the site for the migration, runs only in the `.None` (success) arm. So the very sites the migration targets never get recorded: the accessor fails to specialize first.

The explicit-copy migration has the same problem with decision 17's handle-copy rejection, and solves it by suspending that check while it records. The cloned-accessors migration suspends nothing for the move-only E0901.

## Fix direction

While `migrate_cloned_accessors_on()` is set, the migration has to see the call even when the accessor's specialization fails. Either of these would do it:
- record the site from `_copying_accessor_info` before the call is specialized;
- suspend the deref-copy E0901 inside an accessor that has a `<name>_cloned` sibling, the way decision 17 is suspended for handles.

Then the rename to `<name>_cloned` makes the program evaluate.

The test is a cli-case beside `fix-migrate-cloned-accessors`, with an `ArrayList(String)` fixture like the reproducer. Its golden shows both calls renamed and `check main.yo` passing. It is added with the fix: it fails today.
