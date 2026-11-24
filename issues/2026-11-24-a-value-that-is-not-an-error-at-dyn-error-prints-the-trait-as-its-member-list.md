# Throwing a value that is not an `Error` prints the `Error` trait as its member list, with no error code

**Severity:** S3: a misleading diagnostic. `exn.throw(dyn(Box.new("bad")))` is correctly rejected (a string is not an `Error`), but the message never names `Error`: it prints the trait as its one member's signature, and the required `Dyn` as `Dyn(ToString, (source : …), Clone)`. It carries no error code, so `yo explain` cannot help.

- Filed: 2026-11-24 (lane akc-k2k3k6, re-verifying the pack's "`dyn(Box.new(e))` needs an `Error`" sharp edge with a tree binary built from develop `34359627e`).
- Related: `issues/2026-11-23-e0623-at-a-template-part-names-append-to-and-prints-dyn-with-an-empty-slot.md` records the same type printer's empty slot (`Dyn(ToString, , Clone)`) at a different site.

## Reproducer

```yo
{ Exception } :: import("std/error");

f :: (fn(exn : Exception) -> i32)({
  exn.throw(dyn(Box.new("bad")))
});

main :: (fn() -> unit)({
  exn := Exception(throw : (e -> unwind(())));
  _ := f(exn);
});
export(main);
```

`yo check`:

```text
error: Type &str does not implement the trait (source : fn(self : &Self : (ToString)) -> Option(Box(Dyn(ToString, , Clone)))) required by Dyn(ToString, (source : fn(self : &Self : (ToString)) -> Option(Box(Dyn(ToString, , Clone)))), Clone).
3 |   exn.throw(dyn(Box.new("bad")))
```

## Root cause (suspected, not traced)

The "does not implement the trait" message renders the missing trait with the structural type printer, which writes a trait value as its member list rather than its name; `Error` is a trait extending `ToString` with one member (`source`), so it comes out as `(source : …)` and the `Dyn` as `Dyn(ToString, (source : …), Clone)`. The message is raised without a registered code.

## Fix direction

Print a trait by its declared name (`Error`) in this message and in `Dyn(...)`, give the rejection a code with an explanation that names the repair (wrap the value in a type that implements `Error`, for example a `derive(E, Error(...))` enum), and pin the text with a test.
