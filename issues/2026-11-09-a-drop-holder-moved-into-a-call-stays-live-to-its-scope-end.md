# A `Drop` holder moved into a call stays live to its scope's end

**Severity:** S2. A valid program is rejected: after a holder with a user `Drop` impl moves into a by-value call, the place it borrowed cannot be used again in the same scope.

Filed 2026-11-09 by the G2 lane. Develop `b1af0cd01` (tree build `yo-implorigin-0fae9db61`) rejects the reproducer. Develop `68d531aec` (tree build `yo-implorigin-a2a73fb89`) accepts it. The window is #1839 (O-4, H6: "a holder whose type reaches a user `Drop` is live to its scope-end drop").

## Reproducer

`issues/repros/2026-11-09-a-drop-holder-moved-into-a-call-stays-live-to-its-scope-end.yo`:

```yo
{ assert } :: import("std/assert");
Slots :: struct(a : i32, b : i32);
Entry :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(m : &mut(Slots, p)));
impl(
  generic(p : Origin),
  Entry(p),
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      self.m.a = i32(-1);
    })
  )
);
impl(generic(p : Origin), Entry(p), finish : (fn(self : Self) -> unit)(()));
main :: (fn() -> unit)({
  mut(s) := Slots(a : i32(0), b : i32(0));
  e := Entry(s)(m : &mut s);
  e.finish();
  assert(s.a == i32(-1), "the holder dropped inside finish");
});
export(main);
```

```text
error[E0911]: Cannot read `s.a` here: `e` borrows `s` with `&mut` and is still live, and a `&mut` borrow is exclusive: while it is live, `s`, the places inside it and the places containing it are reached only through `e`.
```

`e.finish()` moves `e`, and its drop runs at the end of `finish`. No drop of `e` remains at `main`'s scope end, so `e` is dead after the call. Rust accepts this program.

## Where to look

The H6 rule extends a `Drop` holder's liveness to its scope-end drop. A holder that was moved has no scope-end drop, so the extension should not apply to it.
