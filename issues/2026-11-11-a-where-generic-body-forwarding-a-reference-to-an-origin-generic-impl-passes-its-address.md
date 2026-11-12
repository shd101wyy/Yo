# A `where`-generic body forwarding a reference to an origin-generic impl passes its address

**Severity:** S2. `via(generic(T), t : &mut T, v : &Rc(X), where(T <: Store))` whose body is `t.put(v)`, called at
`T := Slot(x)` where the impl is `impl(generic(p : Origin), Slot(p), Store(…))`, passes `yo check`, and the C
compiler rejects the specialization: the forwarded `v` is emitted as `&v`, one indirection too many. The same
`via` at a plain struct, and the same forward through a `generic(p : Origin)` function, compile and run.
Pre-existing: v0.2.76 fails the same way.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 B3). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-where-generic-body-forwarding-a-reference-to-an-origin-generic-impl-passes-its-address.yo`
(expects accept, `OUT: 3`):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
Store :: trait(put : (fn(self : &mut Self, v : &Rc(X)) -> unit));
Slot :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(dst : Option(&(Rc(X), p)), n : usize));
impl(
  generic(p : Origin),
  Slot(p),
  Store(
    put : (fn(self : &mut Self, v : &Rc(X)) -> unit)({
      self.n = v.*.s.len();
    })
  )
);
via :: (fn(generic(T : Type), t : &mut T, v : &Rc(X), where(T <: Store)) -> unit)(t.put(v));
main :: (fn() -> unit)({
  x := Rc.new(X(s : String.from("x")));
  mut(s) := Slot(x)(dst : .Some(&x), n : usize(0));
  b := Rc.new(X(s : String.from("bbb")));
  via(&mut s, &b);
  println(`OUT: ${s.n.to_string()}`);
  ()
});
export(main);
```

```text
$ yo check repro.yo        # accepted
$ yo compile repro.yo -o t
error: incompatible pointer types passing '__yo_t_… **' (aka 'struct …_struct ***') to parameter of type
'__yo_t_… *' (aka 'struct …_struct **') [-Werror,-Wincompatible-pointer-types]
yo: error: compile: C compiler failed (exit 1)
```

The emitted specialization of `via`, where `__yo_t_4850…` is `Rc(X)`:

```text
static inline void __yo_fs_3057…(__yo_t_7015…* __yo_v_t, __yo_t_4850…* __yo_v_v) {
  yo_id_9632…(__yo_v_t, (&(__yo_v_v)));      // Slot(p)'s put takes `__yo_t_4850…* __yo_v_v`
}
```

- `…-pos.yo` (positive control): the same `via` and trait at `T := S`, `S` a plain struct with a plain impl; compiles
  and prints `OUT: 3`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `where(T <: Store)` body `t.put(v)` at `T := Slot(x)`, impl `generic(p : Origin)` over `Slot(p)` | check OK, C compile fails | accept |
| the same `via` at a plain `S` with a plain impl | compiles, `OUT: 3` | accept |
| `via(generic(p : Origin), t : &mut Slot(p), v : &Rc(X))` with body `t.put(v)` | compiles, `OUT: 3` (passes `__yo_v_v`) | accept |
| `s.put(&b)` called directly on the `Slot(x)` | compiles, `OUT: 3` | accept |

## Root cause

Measured boundary: the failure needs both a `where(T <: Trait)` dispatch inside a generic body AND an impl that is
itself generic over an origin parameter. In the emitted C the callee's parameter and the forwarder's parameter
have the same type (`Rc(X)*`), and the call site still applies `&`, so the argument-lowering step judged `v` a value
the parameter must lend, not a reference passed on. Hypothesis: on the trait-dispatch route of a specialized
generic body, the impl method is specialized over `p` (its `FuncVal` comes from the generic impl), and the
argument's recorded type or the parameter slot read for the auto-borrow decision is not the one the emitted
signature uses. Not located further.

This is not the R3 family (`issues/fixed/2026-11-06-a-generic-result-at-t-reference-is-lowered-as-a-projection.md`):
no type parameter is bound to a reference here (`T := Slot(x)`), the result is `unit`, and `v`'s type is a spelled
`&Rc(X)` in both signatures.

## Expected

Accept; `OUT: 3`. A reference parameter forwarded to a reference parameter of the same type is passed as is,
whatever route resolves the callee — as the other three rows already do. (Under `plans/VALUES_BY_DEFAULT.md`
decision 42 `v : &Rc(X)` is a `&`-mode parameter; naming it as the argument of another `&` parameter passes the
same reference on.)

## Test

With the fix: the program and its positive control as cases in a trait-dispatch test (`tests/impl.test.yo`, beside
the `where(T <: Trait)` cases), each compiled and run to `OUT: 3`; add the `generic(p : Origin)` forwarder as a third
case.
