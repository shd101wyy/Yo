# A `for` over a field of a match binding of an inline `.Some(…)` is rejected as a compile-time value

**Severity:** S2: a valid program is rejected. Borrowing a field of the match
binding in a `for` fails with "a compile-time value with no runtime storage"
when the scrutinee is an inline `Option(T).Some(…)` built from a runtime value.
Workaround: produce the `Option` from a function call or bind it to a local
first.

> Found 2026-11-07 while writing the regression test for
> `issues/fixed/2026-11-07-a-lent-temporary-of-an-enclosing-statement-is-released-at-an-inner-statements-end.md`.
> Reproduced on develop `f89a24b0d` (stage 1) and on that fix's branch, so the
> fix did not cause it.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
Bag :: struct(items : ArrayList(i32));
main :: (fn() -> unit)({
  (mut(xs) : ArrayList(i32)) = ArrayList(i32).new();
  xs.push(i32(1));
  r := Rc.new(Bag(items : xs));
  (mut(n) : usize) = usize(0);
  match(
    Option(Rc(Bag)).Some(Rc.clone(&r)),
    .Some(entry) => {
      for(&entry.items, x => {
        n = (n + usize(1));
      });
    },
    .None => ()
  );
  println(`n=${n.to_string()}`);
});
export(main);
```

```text
error: Cannot borrow "entry" (`&entry`): it is a compile-time value with no runtime storage to alias.
   --> tmp/fixme5.yo:12:12
   |
12 |       for(&entry.items, x => {
   |            ^^^^^
```

The program compiles and prints `n=1` when the arm reads the field without the
`for` (`n = entry.items.len();`), and also when the scrutinee comes from a call
(`share(&r)` with `share :: (fn(r : &Rc(Bag)) -> Option(Rc(Bag)))(…)`).

## Expected

The program compiles. `Rc.clone(&r)` is a run-time value, so `entry` is a
run-time binding and `&entry.items` borrows it.

## Root cause

Not investigated.
