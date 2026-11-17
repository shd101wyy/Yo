# A fn literal inside `comptime_expect_error` is emitted to C, and its `d.*` of a `&Dyn` is invalid C

**Severity:** S2: a program whose source is accepted fails in the C compiler. `tests/dyn.test.yo` fails to build
on develop `916b279c1`, so all 66 of its tests are reported failed.

**Status:** open. Found 2026-11-17 by the closure-conditional-capture-move lane while running its Tier 1 with a stage 1
built from develop `916b279c1`. The same file passes on the last green develop battery (`1397ee8d3`), so the regression
falls in #1980 (decision 49 S2, the `str` flip). The installed v0.2.78 seed compiles the reproducer.

## Reproducer

`issues/repros/2026-11-17-a-fn-literal-inside-comptime-expect-error-is-emitted-and-derefs-a-fat-dyn-reference.yo`,
built with `--std-path ./std` by a stage 1 of `916b279c1`:

```yo
_UdCounter :: trait(count : (fn(self : &Self) -> i32));
main :: (fn() -> unit)({
  comptime_expect_error((fn(d : &Dyn(_UdCounter, Clone)) -> Box(Dyn(_UdCounter, Clone)))(d.*), "it is a `&T` parameter");
});
export(main);
```

```
tmp/dynrep.c:2185:11: error: indirection requires pointer operand ('__yo_t_…' invalid)
```

The emitted function is `return (*__yo_v_d);` over the fat `__yo_slice_t`-shaped `&Dyn` struct. That is
`tests/dyn.test.yo:1108` ("a Dyn copy out of storage that cannot give it away is E0901 at once").

## Root cause

Not investigated. Two things are wrong at once. The literal inside `comptime_expect_error` reaches codegen, although
the expected error was raised, so the Yo side compiles. And `d.*` of a fat `&Dyn` is lowered as a C `*` of the fat
struct.
