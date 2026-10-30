# `yo fix --migrate mut-bindings` marks only the bodies its run evaluates

**Severity:** S2 — after a sweep, a written local in a generic body (or a platform branch, or an async body that only codegen lowers) that the migration run never evaluated stays unmarked, so once the tree loses its decision 47 exemption a user call that instantiates that body is rejected with E0917 inside the library; the sweep reports success and nothing flags the gap.

**Status:** open. Found 2026-10-25 by the std half of decision 47 locals Generation B
(VBD P5, `plans/handover/VBD_RELEASE_SCHEDULE.md` §5c decision 18). That PR closes every
instance it found in `std/` by hand. The tool limitation stays, and the src half
(v0.2.72) will hit it again.

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
