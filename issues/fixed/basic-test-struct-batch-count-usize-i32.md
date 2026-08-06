# FIXED: `tests/basic.test.yo` — `Test 'struct'` (`usize` vs `i32` on `count`)

**Status:** FIXED 2026-07-30 in `src/env.ts` (+ ported to `yo-self/env.yo`).
`./yo-cli test ./tests` is now **2641 passed, 0 failed**.

## Root cause

A method call on a `*(Self)` receiver resolved to the RAW POINTER's arithmetic
intrinsic instead of the pointee's method of the same name.

`getReceiverMethodsByNameFromEnv` (`src/env.ts`) looks up the generic-impl
registry for the ORIGINAL (pointer) receiver BEFORE the pointee's own methods,
and every later lookup is gated on `methods.length === 0` — so a hit there
suppressed the pointee's methods entirely. That was harmless until the
pointer-operator migration gave `*(T)` the plain methods `add`/`sub`/
`offset_from` (`plans/archive/POINTER_OPERATORS_TO_TRAITS_AND_METHODS.md`,
`std/prelude.yo`'s `impl(generic(T : Type), *(T), add : (fn(self : Self, count :
usize) -> Self), …)`). From then on

```rust
impl(generic(T : Type), MyStruct(T),
  add : (fn(self : *(Self), value : T, where(T <: Add(T))) -> unit)({ … }),
  another_add : (fn(self : *(Self), value : T, where(T <: Add(T))) -> unit)({
    self.add(value);          // ← resolved to the POINTER's add(count : usize)
  }));
```

reported `Failed to synthesize types for parameter "count": Expected "usize",
Given "i32"` — `count` being the pointer intrinsic's parameter, which is why the
error looked unrelated to the test.

## Fix

The pointer-level generic-impl methods are now HELD BACK for an ordinary method
call and appended at the END of the candidate list, so the pointee's method wins
and pointer arithmetic stays reachable whenever the pointee has no method of that
name (`p.add(2)` on `*(i32)` — `i32` has the `(+)` operator, no `add` method).

An INFIX OPERATOR keeps the original priority: the pointee almost always has its
own `==`/`<`, so letting it be found first turns `p > q` into a comparison of the
POINTED-TO values. Measured — doing this unconditionally broke
`tests/ptr.test.yo` and `tests/unsafe.test.yo` at `q > p`.

Regression test: `tests/codegen-bootstrap/pointer_receiver_method_shadowing.yo`
(corpus baseline 147 → 148), which covers BOTH directions.

## Historical detail (why it was hard to see)

## Symptom

```
tests/basic.test.yo
  ✗ Test 'struct'
    Yo compilation error: Failed to import module ".../tests/.yo_test_batch_<ts>_<id>.yo":
```

The message the runner prints is **empty after the colon** — a diagnostic bug in
its own right, and the reason this looks unactionable at first. The real error
only appears if you compile the batch module directly (recipe below):

```
Error: Failed to synthesize types for parameter "count":
Cannot unify incompatible types:
Expected: "usize"
Given: "i32"
```

`count : usize` is the allocator parameter (`std/allocator.yo:32,43,45,47`), so
something in the batch reaches an `alloc`-family call with an `i32` count.

## Batch-only

The test's own body compiles fine standalone, and so does it wrapped in a
`cond` arm — I checked both:

- `/tmp/structfail.yo` (the `Point` / `comptime_expect_error` block on its own) → rc=0
- `/tmp/structarm.yo` (same block as a `cond` arm body) → rc=0

So the trigger needs more of the file's context than the single test — most
likely an interaction between the ~15 `begin(...)` blocks the batch splices into
one arm (the arm contains all of `Test 'struct'`'s sub-blocks, including the
`MyStruct :: (fn(comptime(T) : Type) …)` generic-impl block and the `Withdraw`
impl with `return` inside a `cond`).

## Reproduction recipe (the useful part)

The runner deletes the batch file on exit, so capture it mid-run, then `check` it
— that surfaces the real error and a caret into the generated source:

```bash
# 1. capture the batch module while the test runs
(./yo-cli test ./tests/basic.test.yo --parallel 1 \
   --test-name-pattern "Test 'struct'" &> /tmp/bs.log &)
for i in $(seq 1 100); do
  f=$(ls tests/.yo_test_batch_*.yo 2>/dev/null | head -1)
  [ -n "$f" ] && cp "$f" /tmp/captured_batch.yo && break
  sleep 0.2
done

# 2. check it in place (it must live under tests/ to resolve its imports)
cp /tmp/captured_batch.yo tests/_dbg_batch.yo
./yo-cli check tests/_dbg_batch.yo          # prints the real error + caret
rm -f tests/_dbg_batch.yo
```

The caret lands at a character offset inside one enormous generated line
(`:11:5622` in the run I captured), so to localise further, split the arm's
`begin(...)` blocks into separate files and bisect.

## Next steps

1. Bisect the arm's `begin(...)` blocks to the smallest failing pair.
2. Fix the underlying `usize`/`i32` unification at the allocator call.
3. Separately: make the test runner propagate the inner error text instead of
   printing `Failed to import module "…":` with nothing after it. That empty
   message is what made this failure look inscrutable.
