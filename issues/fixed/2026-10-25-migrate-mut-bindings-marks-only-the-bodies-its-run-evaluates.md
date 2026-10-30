# `yo fix --migrate mut-bindings` marks only the bodies its run evaluates

**Severity:** S2 — after a sweep, a written local in a generic body (or a platform branch, or an async body that only codegen lowers) that the migration run never evaluated stays unmarked, so once the tree loses its decision 47 exemption a user call that instantiates that body is rejected with E0917 inside the library; the sweep reports success and nothing flags the gap.

**Status:** fixed 2026-10-30 (branch `fix/mut-bindings-coverage`, for v0.2.74). Found
2026-10-25 by the std half of decision 47 locals Generation B (VBD P5,
`plans/handover/VBD_RELEASE_SCHEDULE.md` §5c decision 18), which closed every instance it
found in `std/` by hand.

## Evidence

`yo fix ./std --migrate mut-bindings` with the tree binary marked 1,050 bindings and
reported nothing left. With `std/` no longer exempt, the same tree then rejected valid
programs:

```text
error[E0917]: Cannot assign to `woken`: it is a binding declared without `mut`, so it is immutable (plans/VALUES_BY_DEFAULT.md decision 47).
    --> tests/async/.yo_selftest_batch_348068_1_0.yo:18:156
...
note: raised here, inside the standard library
    --> std/async/channel.yo:304:7
    |
304 |       woken = w.is_woken();
    |       ^^^^^
```

`tests/async/channel.test.yo` fails to compile that way (all 22 cases), and
`tests/int_checked_arithmetic.test.yo` fails the same way, first at `checked_pow`'s
`acc = v` (`std/prelude.yo:5008`), whose neighbours `wrapping_pow`, `isqrt` and `ilog*`
were unmarked as well. Both files pass once the sites are marked; they are this
issue's regression tests for std.

The migration's census sees only what evaluation reaches:

1. **Generic bodies.** A function with `generic(...)` parameters, and every method of
   a generic `impl`, is evaluated per instantiation. `check ./std` instantiates few of
   them, so the prelude's integer methods, the iterator adapters, `HashSet`'s set
   algebra, `ArrayList.index_of`, `OrderedMap.remove`, `std/io/bufio` and
   `std/async`'s `select`/`race` were never visited.
2. **Platform branches.** A `cond(platform == ...)` arm for another target is
   pruned (`std/crypto/random.yo`'s WASI/Emscripten `getentropy` loop).
3. **Bodies only codegen reaches.** A `yo fix` run on a test file that does call
   `Channel.send` still left `_wake_one_receiver`'s `woken` unmarked; compiling the same
   file rejects it.

Before this PR the exemption hid the gap: E0917 never applied to std, wherever its
bodies were instantiated.

## How the std half closed it (the recipe for src)

1. `yo fix ./std --migrate mut-bindings`.
2. Re-run it with every test tree in the file list
   (`yo fix ./std tests/*.test.yo tests/<dir> ... --migrate mut-bindings`). Only files in
   the list are rewritten, but each site is recorded wherever its token lives, so test
   bodies that instantiate std generics mark std.
3. Re-run it per target (`--target aarch64-apple-darwin`, `x86_64-pc-windows-msvc`,
   `wasm32-wasip1`, `wasm32-unknown-emscripten`).
4. Re-run it with `src/main.yo` in the list (then revert `src/main.yo`): the compiler
   instantiates a lot of std. It found nothing new in std.
5. Compile the language suite with the tree binary and the exemption dropped, and
   grep for E0917 raised inside the library.
6. Lexically scan for written but unmarked declarations and pattern bindings (a
   reassignment, `&mut name`, a `&mut self` method of a value type), and decide each
   hit by hand. Most hits are `ref` handles (`ArrayList`, `HashMap`, `StringBuilder`,
   `HttpResponse`, `Rng`), which are written through, not written.

## Fix direction

A sound migration has to see every body. Two options:

- Evaluate each generic body once with its parameters held abstract, in a
  record-only mode.
- Record lexically: a reassignment, `&mut name` or a field store on a binding, plus a
  `&mut self` call whose receiver's declared type is known to be a value.

The first is the evaluator's "check a generic definition" pass, which Yo does not have.
The second needs only the AST, but cannot see through inferred types. Until one of
them exists, the hunt above is part of every decision 47 sweep.

## Root cause

The migration recorded a write only where `binding_require_mut` / `place_require_mut`
ran, that is, where evaluation reached the write. Measured with `YO_DEBUG_SWALLOW=1`:
a generic body's definition-time trial binds its type parameters to `SomeT` and stops
at the first construct the evaluator cannot type that way (`T(1)`, "TypeVal SomeT
callee without FnTrait"; `rhs > T(0)` typed as non-`bool`); the error is swallowed
and every statement after it goes unvisited. A blanket `impl`'s default method (the
prelude's iterator adapters) gets no trial at all, a `cond(platform == ...)` arm for
another target is pruned, and an instantiation sees only the types the run happens to
use.

## Fix

`yo fix --migrate mut-bindings` now has a lexical half (`_mbl_run`, `src/main.yo`).
After the evaluating pass it walks every listed file as parsed, resolves each written
name through the block, closure, `match` arm, `for` and parameter scopes around it
(past a `fn` literal only compile-time bindings resolve), and judges every write that
evaluation did not:

- A reassignment always writes its binding (a `(x : T);` declaration counts as written
  when assigned twice, or inside a loop or closure it is declared outside of).
- A field or element store, a `&mut` lend and a `&mut self` call write it when the
  place is the binding's own storage. Evaluation records what it learned about each
  declaration it reached outside a generic specialization (`take_mut_decl_facets`,
  `take_mut_decl_heads`, `src/env.yo`): whether a lend, a field step, an element step
  or a dereference lands in the binding's storage, whether it is a borrow, and its type
  head. A declaration evaluation never reached is judged as a value.
- Whether `recv.m(...)` lends `recv` exclusively comes from the `impl` and `trait`
  blocks of std and the listed files: a name declared both ways resolves by the
  receiver's type head, else by the trait that declares it.
- Evaluation records each write it judged (`record_mut_judged`, `src/expr_info.yo`) and
  the walk leaves those to its verdict, so evaluated code keeps its exact answers. A
  judgment inside a generic body's specialization is not recorded: another
  instantiation may hold a value where this one holds a handle.

Measured by stripping every `mut(...)` below module level from `std/` (1,125 markers)
and running one `yo fix ./std --migrate mut-bindings`, with no test trees, targets or
`src/main.yo` in the list:

| binary | restored | missed | spare |
| --- | --- | --- | --- |
| v0.2.73 (seed) | 1,052 | 73 | 0 |
| this fix | 1,125 | 0 | 4 |

The hunt above closed this class by hand (71 sites plus rebinds). The 4 spare markers are `ArrayList` locals in
bodies no evaluation reached (`HashMap.from`, `HashSet.from`, two in `std/http/wire.yo`):
the walk cannot see that the type is a `ref` handle today. They become required when
B8–B11 make the collections values.

Regression test: `tests/cli-cases/fix-migrate-mut-bindings-reaches-unevaluated-bodies`
(a generic body past its trial's `T(1)`, a blanket `impl` default and another target's
`cond` arm; `check use.yo`, which instantiates them, failed with E0917 inside `lib.yo`
before the fix). `YO_DEBUG_FIX_LEXICAL_ONLY=1` makes the walk judge every write and
prints each binding evaluation marked that the walk did not.
