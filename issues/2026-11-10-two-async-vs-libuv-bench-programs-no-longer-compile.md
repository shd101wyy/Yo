# `scripts/bench/async-vs-libuv/{std_vs_raw,bench}.yo` no longer compile

**Severity:** S3. Benchmark programs no gate compiles: `scripts/bench-std-vs-raw.sh`
and `scripts/bench-vs-libuv.sh` fail at their `yo compile` line. Nothing in CI
runs them (they are merge-criterion tools, not gates), so the rot was silent.

Found 2026-11-10 while fixing
`issues/fixed/2026-11-10-the-io-bench-script-no-longer-compiles-since-move-only-join-handles.md`,
by compiling every Yo file under `scripts/` with a tree binary
(`scripts/build_site.yo`, `bench/io_bench.yo` and `bench/io_budget.yo` are
fine).

## Reproduction

```text
$ yo compile scripts/bench/async-vs-libuv/std_vs_raw.yo
error[E0901]: ... cannot copy what `ArrayList(TcpStream).get` copies (its element), whose type `TcpStream` is move-only ...
  --> std_vs_raw.yo:126:19   c := clients.get(usize(0)).unwrap();
```

and, after moving the streams out of the lists (`swap_remove`, tried and
reverted), a second error that needs a redesign of the benchmark:

```text
error[E0909]: This value borrows `self` (a place in the future's origin), so it is second-class and cannot be spawned ...
  --> std_vs_raw.yo:114:29   acc := io.spawn(listener.accept(io), e);
```

```text
$ yo compile scripts/bench/async-vs-libuv/bench.yo
error[E0901]: use of moved value: `done` is moved inside the loop, and the next iteration uses it again.
  --> bench.yo:156:32   task := io.async((io : Io) => { ... done.try_send(()) ... });
```

## Cause

Both were written before `TcpStream`/`Channel` handles were move-only or
counted-handle captures became explicit moves (decisions 17/26, the owning
`JoinHandle`, decision 43's borrowing futures). `std_vs_raw.yo` spawns
`listener.accept(io)`, a future that borrows the listener, which a spawn can
no longer take.

## Expected

Port both to the current API (move or `clone()` the handles, accept inside the
task that owns the listener) and compile them in a CI step so they cannot rot
again; the `I/O budgets` job already builds `io_budget.yo` and `io_bench.yo`.
Not fixed here: the benchmarks measure scheduler/allocator behaviour, and the
port changes what they measure, which is the benchmark owner's call.
