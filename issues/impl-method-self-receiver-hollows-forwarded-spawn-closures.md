# A closure parameter forwarded into a spawn primitive from a `self`-receiver method is specialized only once

**Status:** OPEN — worked around in `std/thread.yo` (its `spawn` is a
module-level function, not a `pool.spawn(cb)` method).

**Severity:** HIGH — the failure is **silent**. The affected task bodies are
emitted as `// Failed to transpile` comments; the program compiles, links,
runs, and the tasks simply never do anything. `yo check` is clean.

## Symptom

Given a helper that takes a task closure and hands it to `__yo_worker_spawn`
(or `__yo_thread_spawn`), the closure is specialized **once**. In a program
with N differently-shaped task closures, N−1 of them are dropped:

```
// Failed to transpile return(x + y);
// Failed to transpile assert(result == i32(30), "async result should be 30");
// Failed to transpile (out.fetch_add)(i32(4), (MemoryOrder.AcqRel));
```

## Reproducer

`issues/repros/spawn-closure-param-through-self-method.yo` — four task
closures, one `Pool.submit(self, cb)` method.

```
yo compile issues/repros/spawn-closure-param-through-self-method.yo --release -o /tmp/r.out
grep -c "Failed to transpile" /tmp/r.out.c   # => 3
/tmp/r.out                                   # => out=11   (expected out=15)
```

Shape 1 (`+1`), shape 2 (`+2`) and shape 4 (`+8`) run; shape 3 (`+4`) is
hollow, so the program prints 11 instead of 15.

## Measured boundary

The trigger is the **`self` receiver on the forwarding function**, not the
receiver's type, not the extra statements around the spawn, and not the spawn
primitive:

| forwarding form                                                     | result |
| ------------------------------------------------------------------- | ------ |
| module-level `spawn(cb)` → `__yo_worker_spawn(cb)`                  | OK (0 failures, out=15) |
| module-level `submit(pool, cb)` → `__yo_worker_spawn(cb)`           | OK (0 failures, out=15) |
| static impl method `Thread.spawn(cb)` (no `self`)                   | OK (0 failures, out=15) |
| method `spawn(self : Self, cb)` on an `atomic(ref(struct))`         | BROKEN (3 failures, out=11) |
| method `spawn(self : Self, cb)` on a plain `struct`                 | BROKEN (3 failures, out=11) |
| method with `self` unused in the body                               | BROKEN (3 failures, out=11) |
| method that delegates to a module-level `_submit(cb)`               | BROKEN (3 failures, out=11) |

So a *single* `self`-receiver frame anywhere on the path from the call site to
the spawn primitive collapses the specializations.

## Where to look

`src/evaluator/calls/helper.yo` — the closure-parameter specialization path
(`create_capture_type_and_value` at ~3121, `register_closure_capture_info`).
Capture info is registered per closure `func_id`, i.e. per AST node, and the
method-call path appears to reuse one entry across specializations of the
receiver method instead of creating one per specialization.

## Impact today

- `std/thread`'s pool submission must stay a module-level `spawn(pool, cb)`.
  Turning it into a method silently hollows every task shape after the first.
- Any future std API that takes a task closure and forwards it to a spawn
  primitive is subject to the same rule.
