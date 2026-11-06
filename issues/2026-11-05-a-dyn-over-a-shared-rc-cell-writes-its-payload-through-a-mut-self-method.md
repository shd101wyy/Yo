# A `Dyn` over a shared `Rc` cell writes its payload through a `&mut Self` method

**Severity:** S2. `dyn(h)` over an `Rc(V)` handle whose cell has another live handle builds a `Dyn` whose `&mut Self` vtable methods write the shared payload. Decision 46 forbids that write: the direct spelling `h.*.n = v` is E0919. A `&` borrow of the payload taken through the other handle changes under the write.

Found 2026-11-05 by the design consult on `dyn`'s auto-boxing (VERDICTS-26, Observation 2), with v0.2.75 on develop `58ec8be03`.

## Reproducer

`issues/repros/2026-11-05-dyn-over-a-shared-rc-writes-its-payload.yo`:

```yo
r := Rc.new(Counter(n : i32(0)));
r2 := Rc.clone(r);
(mut(d) : Dyn(Bump)) = dyn(r);
d.bump();
d.bump();
println(`through d: ${d.get()}; through r2: ${r2.*.n}`);
```

It compiles and prints `through d: 2; through r2: 2`. Writing `r.*.n = i32(1)` at the same point is E0919 ("an `Rc`'s payload is shared, so it is read-only through the handle").

## Root cause

`evaluate_dyn_value` (`src/evaluator/values/dyn.yo`, the `cell_handle_view` arms of the auto-box test) adopts an `Rc`/`Arc` argument's cell as the `Dyn`'s data object instead of boxing it. The vtable wrapper hands each method `&mut` of the cell payload (`src/codegen/functions/dyn.yo`, `generate_dyn_wrapper_functions`, the `is_boxed` branch). Decision 46 is checked only on syntactic writes through `h.*`, so nothing sees a write made through the `Dyn`.

## Fix

`plans/VALUES_BY_DEFAULT.md` decision 49 (2026-11-05). `dyn(h)` over an `Rc(V)` has the type `Rc(Dyn(Bump))`, which is shared and read-only through the handle, so `d.bump()` is E0919. Generation A removes the adoption path. The test, a `comptime_expect_error` row in `tests/dyn.test.yo`, lands with decision 49's tests.
