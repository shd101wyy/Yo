# A ref element borrow is rejected beside an `Io` argument (regression in #1619)

Found during the B4-3c final gates (2026-10-26): `yo test tests/async_await.test.yo`
fails on clean develop `6b288e5e1` (#1621) — 200 passed / 85 failed, the whole second
batch refusing to compile — and a plain, non-async call shape that #1615 accepted is
now wrongly rejected.

**Severity:** S2 — valid programs are wrongly rejected: any call that lends `&mut
xs(i)` (an element of a container) while also passing the runtime object `io : Io`
— the bread-and-butter shape of `io.async` code — is rejected with a
container-realloc diagnostic; `tests/async_await.test.yo` is red on develop, which
turns the language-suite battery red.

## The two symptoms

1. A valid plain call is rejected (accepted on `a27cd5f01`, before #1619):

   ```yo ignore
   _a2_plain :: (fn(c : &mut i32, io : Io) -> unit)({ c = (c + i32(1)); });
   main :: (fn() -> unit)({
     xs := ArrayList(i32).new();
     xs.push(i32(1));
     _a2_plain(&mut xs(usize(0)), io); // <-- rejected on 6b288e5e1
   });
   ```

   `yo check` on `a27cd5f01`: clean. On `6b288e5e1`:

   ```text
   error: A 'ref' argument ("xs(usize(0))") borrows into the container "xs", but
   argument 2 of the same call could hold a handle to "xs" and grow it, reallocating
   the buffer the reference points into. Read the element into a local first
   ("xs.get(i)" copies it, std/mem's "take(&mut xs(i))" moves it out), or split the calls.
   ```

2. The §3.13 A2 negative test flips its message, so `comptime_expect_error` misses.
   `tests/async_await.test.yo`, "a borrowing future cannot hold an element lent
   through an index (decision 38 D, §3.13 A2)":

   ```yo ignore
   comptime_expect_error(
     io.await(_a2_bump_i32(&mut xs(usize(0)), io), io),
     "lives in a shared mutable cell"
   );
   ```

   Before #1619 this raises E0909 ("...that place lives in a shared mutable cell...",
   `src/evaluator/calls/function.yo:4000`); on #1621 the new flowability diagnostic
   fires first, `comptime_expect_error` reports "the expression raised an error, but
   not the expected one", the synthesized batch fails to compile, and the 85 tests of
   that batch (including this one) do not run.

## Root cause

#1619 (33d2c48bf, B6-a) grew `_reject_if_container_reachable` in
`src/types/flowability.yo` (+197 lines): rule (b) rejects a `ref` argument that
borrows into a container when ANY sibling argument's type "could hold a handle to"
that container, judged by representation (`_ref_place_holder_types` +
`_type_may_reach_any_of`, with F1's function-typed-sibling rule and F2's
`Rc(.FutureTraitT)` reach). `Io` (std/prelude.yo:12980) is four `fn`-typed fields
whose signatures carry `Impl(Future(generic T, E))`; through F1/F2 the walk
concludes `Io` can hold any container — including the caller's `ArrayList(i32)` —
so every `f(&mut xs(i), io)` shape is rejected. `Io` is the runtime object passed
beside ref arguments by essentially all async code, and it can never hold the
caller's container.

## Repro

`issues/repros/2026-10-26-a-ref-element-borrow-is-rejected-beside-an-io-argument.yo`
(the symptom-1 program, with `io :: __yo_builtin_io;`):

- `yo check <repro> --std-path ./std` with a `a27cd5f01` binary — passes.
- with a `6b288e5e1` (or later) binary — the realloc error above.

## Fix direction (not fixed here — flowability is B6-a's file)

Rule (b) needs a representational exemption for the runtime object: an `Io`-typed
sibling cannot hold the caller's container (its `fn` fields' generic
`Impl(Future(T, E))` positions are the runtime's own instantiation machinery, not
user storage), or more generally a generic type parameter of a *function type's
signature* must not count as "may hold any type" when judging the sibling. Until
then, `tests/async_await.test.yo`'s §3.13 A2 batch cannot compile on develop; the
fix must re-run `tests/async_await.test.yo` and `tests/ref_field_borrow.test.yo`.

B4-3c is not affected: the same test file fails byte-for-byte the same way on the
clean `6b288e5e1` base binary and on the B4-3c head binary (both 200/85), and the
base-vs-head corpus C for `tests/async_await.test.yo` is byte-identical.
