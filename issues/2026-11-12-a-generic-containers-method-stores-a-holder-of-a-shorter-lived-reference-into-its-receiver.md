# A generic container's method stores a holder of a shorter-lived reference into its receiver

**Severity:** S1 — safe code reads freed memory: `Stack(H).push(H(r : &b))` with `b` local to an inner block is accepted, and reading `st.top` after the block is a heap-use-after-free under ASan. v0.2.76 accepts the program too.

Found 2026-11-11 by the ownership / borrowing / origin audit (`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A4; probes `generics/s01-stack-push-holder` and `generics/s01b-stack-push-ufcs`); re-measured 2026-11-12 on develop `4f8f975b3`, after #1913 routed method, qualified and fn-value calls through `lend_through`.

## Reproducer

`issues/repros/2026-11-12-a-generic-containers-method-stores-a-holder-of-a-shorter-lived-reference-into-its-receiver.yo`:

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
H :: struct(r : &Rc(X));
Stack :: (fn(comptime(T) : Type) -> comptime(Type))(struct(top : Option(T), n : usize));
impl(
  generic(T : Type),
  Stack(T),
  push : (fn(self : &mut Self, v : T) -> unit)({
    self.top = .Some(v);
    self.n = (self.n + usize(1));
  })
);
main :: (fn() -> unit)({
  x := Rc.new(X(s : String.from("x")));
  mut(st) := Stack(H)(top : .Some(H(r : &x)), n : usize(1));
  {
    b := Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
    st.push(H(r : &b));
  };
  match(&st.top, .Some(h) => println(`OUT: ${h.r.*.s.len().to_string()}`), .None => println("none"));
  ()
});
export(main);
```

| Binary | `yo check` | ASan run (`--optimize 1 --sanitize address --allocator system`) |
| --- | --- | --- |
| v0.2.76 | accepted | heap-use-after-free |
| develop `4f8f975b3` | accepted | heap-use-after-free |

The UFCS spelling `Stack(H).push(&mut st, H(r : &b))` behaves the same.

## What #1913 fixed and what it did not

#1913 makes `lend_through` see a method call. The impl-origin forms, `impl(generic(p : Origin), H(p), …)` with a method that stores a `&(T, p)` into `self`, are E0923 now (audit probes `generics/t16b`/`d`/`e`/`g`, `holders/u03`/`u10`/`u11`/`u13`). Here the receiver's type is `Stack(T)` at `T := H`, and `H` carries an origin only through its `&Rc(X)` field: no origin parameter is spelled anywhere, so the flow write-back of `lend_through` step 3 has no origin variable to widen, and `st` keeps the origin it was declared with (`x`).

## Expected

E0911 at the read of `st.top` after the block (or E0923 at the `push`): `push(self : &mut Self, v : T)` stores `v` into `self`, so `v`'s origin (`b`) must join `st`'s flow set, exactly as it does for a non-generic holder.

## Test

With the fix: the reproducer as a `tests/origins/unsound/` pair (negative; positive control with `b` declared before `st`) and a corpus row.
