The sh172 stage-2 control is still running after ~55 min; I report that item as incomplete. Everything else below is measured.

---

# (A) tests/basic.test.yo arm 12

**Verdict: `g4_min` is a SEPARATE bug — it is NOT arm 12's current root. It is arm 12's _second_ root, unmasked once the first is fixed. Both are now root-caused and both fixes are measured green.**

## 1. MINIMAL REPRO

### A1 — the actual HEAD blocker (`_` reroute). `/Users/yiyiwang/Workspace/Yo/scratchpad/t5/A_nom1.yo`

```rust
main :: (fn() -> unit)({
  Point1 :: struct(x : i32, y : i32);
  Point2 :: struct(x : i32, y : i32);
  x := Point1(3, 4);
  (y : Point2) = _(5, 6);
  b := (y.x == 5);
  b;
  ()
});
export(main);
```

|          | command                                                          | result                                                                                                                                                                          |
| -------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sh172    | `/tmp/sh172 compile scratchpad/t5/A_nom1.yo --release -o /tmp/x` | **rc=1**, C: `void _file____User_temp_1841 = // Failed to transpile (y.x) == 5;`, and `y` typed `__yo_t2` with fields **`__field_yo_id_2993/__field_yo_id_2994`** (not `.x/.y`) |
| ./yo-cli | same                                                             | **rc=0**, `__yo_struct_yoba860c41_id_29 y = (…){ .x = 5, .y = 6 };`                                                                                                             |

Arm 12 at HEAD, marker-checked: `hollow=1` (vacuous pass). Un-silenced-swallow probe `/tmp/t5probe` gives the hollowing cause verbatim:

```
__DBG_FT swallowed: Error: Cannot unify incompatible types:
Expected: "bool"
Given: "unit"
```

at batch col 1161 = `assert((y.x) == 5)` — i.e. `y.x` resolved to nothing because `_(5,6)` minted a fresh anon struct instead of constructing `Point2`.

### A2 — the second blocker (== `g4_min`). `/Users/yiyiwang/Workspace/Yo/scratchpad/t5/A_g4_min.yo` (verbatim copy of `w6/g4_min.yo`)

|          | result                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| sh172    | rc=1 `initializing 'int32_t' … incompatible type '__yo_t2'`; **one** `typedef … // Tuple(0 : S)` for two layouts |
| ./yo-cli | rc=0; **two** typedefs `__yo_tuple_struct_yod9443aa6_id_6` and `…_id_29`                                         |

Proof this is arm 12's next blocker, not a bystander: with A1 applied (binary `/tmp/t5p1`), arm 12 becomes **`hollow=0`** but the batch fails C compile with the _same_ signature at the "struct in tuple" section:

```
.yo_selftest_batch_1.bin.c:3363: error: initializing 'int32_t' … incompatible type '__yo_t26'
   __yo_t31 c = (__yo_t31){ ._0 = (__yo_t26){ .x = 3, .y = true } };
```

15-line distilled form `/Users/yiyiwang/Workspace/Yo/scratchpad/t5/A_tup13.yo` (two sibling blocks, each `SomeStruct :: struct(x:i32,y:bool)` + `Tuple(...)`): rc=1 under `/tmp/t5p1`. Control `A_tup13b.yo` — identical but the 2nd struct renamed `OtherStruct` — **rc=0**. The collapse is purely **name**-driven.

## 2. ROOT

**A1** — `yo-self/evaluator/exprs/_expr.yo:544-551`. The BK*ANON_STRUCT arm reroutes `*()` to the expected type's constructor **only when the expected struct is unnamed**:

```rust
expected_is_anon_struct := match(
  et_ty,
  .Struct({ name : et_sname, is_source_namespace : et_sns }) => ((et_sname.len() == usize(0)) && !(et_sns)),
  _ => false
);
```

This gate is deliberate (see `issues/yo-self-anon-struct-literal-expected-type-ctor.md` § "Scope narrowing"), not accidental. For a NAMED expected (`Point2`, `SomeStruct`) it falls to `evaluate_anonymous_struct_value`, minting a fresh struct id with synthesized field names.

**A2** — `yo-self/types/type_key.yo:481-581`, `_stable_identity_at`. It has arms for `.Struct`, `.EnumT`, `.Pointer` and then `_ => type_to_string(t)` (line **579**). A `.Tuple` falls into that fallback, and `type_to_string` renders a Struct **by name** (`types/string.yo`), so `Tuple(S_i32)` and `Tuple(S_i64)` both render `Tuple(0 : S)`. `yo-self/codegen/types/collection.yo:224-232` then treats the second arrival as "same type, evolved key" and calls `context.register_type_alias(tk, prev_key)` → one `__yo_tN` for two layouts. `type_key` itself is correct here (it _does_ have a `.Tuple` arm at `type_key.yo:420` that recurses); only the stable-identity twin is missing it.

## 3. TS MECHANISM

**A1** — `src/evaluator/calls/function.ts:445-466`, verbatim:

```ts
      // Check _ function
      if (functionName === "_") {
        const expectedType = context.expectedType;
        if (!expectedType || isSomeType(expectedType.type)) {
          // Make it as an anonymous struct
          return evaluateAnonymousStructValue({ expr, env, context });
        }
        functions = [
          {
            type: typeOfType(expectedType.type),
            value: createTypeValue(expectedType.type),
          },
        ];
```

The only exemption is `isSomeType` — **named structs are rerouted**.

**A2** — `src/types/creators.ts:698-706`, verbatim:

```ts
export function createTupleType(fields: TypeField[]): TupleType {
  ...
  const tupleType: TupleType = {
    id: `tuple_${fields.map((e) => e.type.id).join("_")}`,
```

Tuple identity is the **field type ids**, and a struct id is `struct_${randomId(env.modulePath)}` (`creators.ts:723`) — per-declaration, never a name. `src/codegen/types/collection.ts:351` keys the C registry off exactly that: `if (context.types[type.id]) return;`. No name-based render ever participates in TS tuple identity.

## 4. YO-SELF DELTA (anchors verified `grep -c == 1`)

| #   | file:line                              | anchor                                                                                                                                                                                                                           |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `yo-self/evaluator/exprs/_expr.yo:544` | `expected_is_anon_struct := match(` — `grep -c` = **1**                                                                                                                                                                          |
| A1  | `yo-self/evaluator/exprs/_expr.yo:546` | `.Struct({ name : et_sname, is_source_namespace : et_sns }) => ((et_sname.len() == usize(0)) && !(et_sns)),` — **1**                                                                                                             |
| A2  | `yo-self/types/type_key.yo:573-579`    | the `.Pointer(pointee) => {…}` arm **immediately followed by** `    _ => type_to_string(t)` — the 8-line block is **1** (the bare `_ => type_to_string(t)` line alone is **2**: also at :444 in `type_key`; do not use it alone) |

## 5. PROPOSED PATCH (validated — applied to copies under `scratchpad/t5/p1`, `scratchpad/t5/p2`, built, and run)

**A1** — `_expr.yo:544-548`, replace the five-line `expected_is_anon_struct := match(...)` with:

```rust
            expected_is_anon_struct := true;
```

(leaves the `&& !(is_some_type(et_ty))` guard on line 550 in place, which is exactly TS's only exemption). Tree: `scratchpad/t5/p1`, binary `/tmp/t5p1`.

**A2** — `type_key.yo`, insert before `    _ => type_to_string(t)` at line 579 (inside `_stable_identity_at` only):

```rust
    // Tuple: parity with `type_key`'s Tuple arm — RECURSE into the field
    // types. Without this arm a tuple fell to `type_to_string`, which renders
    // a Struct field by NAME, so two sibling blocks each declaring a local
    // `S` and `C :: Tuple(S)` both rendered `Tuple(0 : S)` — collect_type then
    // ALIASED the second tuple's type_key onto the first's C type and emitted
    // one `__yo_tN` for two different layouts.
    .Tuple(sti_labels, sti_fts) => {
      out := String.from("tup");
      (sti_i : usize) = usize(0);
      while(sti_i < sti_fts.len(), {
        out.push_str("_");
        match(
          sti_labels.get(sti_i),
          .Some(sti_l) => if(sti_l.len() > usize(0), {
            out.push_string(sti_l.clone());
            out.push_str(":");
          }),
          .None => ()
        );
        match(
          sti_fts.get(sti_i),
          .Some(sti_ft) => {
            out.push_string(recur(sti_ft, depth + usize(1)));
          },
          .None => ()
        );
        sti_i = (sti_i + usize(1));
      });
      out
    },
```

Tree: `scratchpad/t5/p2` (= p1 + A2 + patch B), binary `/tmp/t5p2`. Built with `./yo-cli compile <tree>/main.yo --release`; `./yo-cli fmt` run first on every edited file.

**Measured with `/tmp/t5p2`:**
| probe | HEAD (sh172) | P1 (A1) | P2 (A1+A2+B) |
|---|---|---|---|
| `A_nom1.yo` | rc=1, 1 marker | rc=0, 0 markers, `.x=5,.y=6` | rc=0 |
| `A_g4_min.yo` | rc=1 | rc=1 (unchanged) | **rc=0, two tuple typedefs `__yo_t1`/`__yo_t3`** |
| `A_tup13.yo` | — | rc=1 | **rc=0** |
| **arm 12 isolated** | pass but `hollow=1` | `hollow=0`, C error | **`1 passed`, `hollow=0`** |
| `tests/basic.test.yo` full | 33/33, file `hollow=1` | — | 33/33, file `hollow=1` — file-level hollow root **moves to arm 18**: `__DBG_FT swallowed: Error: Expected type for rhs, got begin(assert(true), ())` |
| `tests/async_await.test.yo` full | 116/116 | — | 116/116 (no regression) |
| `check ./std` | 0 `error in` | — | 0 `error in` |

## 6. BLAST RADIUS

- **A1** touches every `_()` / `{ … }` literal site with a _named_ expected struct — i.e. essentially all of yo-self's own struct literals. `issues/yo-self-anon-struct-literal-expected-type-ctor.md` records that the broad rule previously made the **stage-2 binary SIGSEGV at prelude eval**. My measurement (below) says A2 does **not** clear that.
- **A2** is read only by `collect_type` (`stable_type_identity` has exactly 3 references: definition, export, and `codegen/types/collection.yo:224`). It can only turn a _false alias_ into _no alias_; equal renders still imply equal structure. Regression mode: a genuine "same type, evolved type_key" re-arrival whose struct copies carry different `sid`s now registers twice instead of aliasing → duplicate C declaration. Not observed in any measurement above.

## 7. CONFIDENCE + open item

Roots: **high** (both isolated to a single line each, both confirmed by a rename/gate control and by TS-vs-yo-self C diffs).

**Open, measured negative:** stage-2 self-emission with A1+A2 **crashes**. `/tmp/t5p2 compile scratchpad/t5/p2/main.yo --release -o /tmp/t5s2` → **rc=138 (SIGBUS), empty log, reproduced twice** at ~13 min. The HEAD control (`/tmp/sh172 compile yo-self/main.yo --release`) was **still running at ~55 min and never crashed** — strong but not conclusive. So A2 is _not_ the downstream gap that forced the A1 gate narrowing; there is a third defect in that chain.

**Cheapest settling observation:** let the sh172 control finish (it is still running, output `/tmp/t5s2ctl.log`, rc will land in `/tmp/t5s2ctl.rc`). If it succeeds, bisect A1 vs A2 by building a tree with **A2 only** (no gate widening) and self-emitting; A2-only self-emission passing would prove the SIGBUS belongs entirely to A1.

---

# (B) tests/async_await.test.yo arm 65

**Verdict: the recorded root is closer to right than the refutation. The "two SomeTypes that PRINT IDENTICALLY" claim is FALSE at HEAD — they print DIFFERENTLY, and the difference is exactly `T`/`E` being unbound. `scratchpad/w4/w1.yo` is a real bug and my fix clears it, but it is NOT arm 65's bug: arm 65 still fails with the compat port applied.**

## 1. MINIMAL REPRO

`/Users/yiyiwang/Workspace/Yo/scratchpad/t5/B_io_variant.yo` (13 lines, **no bundle struct, no `Ctx`** — plain `Io`):

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/string"));
open(import("std/fmt"));
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  (task : Impl(Future(i32, Io))) = io.async((io : Io) => {
    io.await(yield(io), io);
    i32(100)
  });
  result := io.await(task, io);
  ()
});
export(main);
```

|               | command                                        | result                                                                                                                                                                            |
| ------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ./yo-cli      | `./yo-cli check scratchpad/t5/B_io_variant.yo` | **evaluator OK**                                                                                                                                                                  |
| sh172 / probe | `/tmp/t5p3 check …`                            | swallowed at def-time (rc=0 because swallowed): <br>`Incompatible types:`<br>`- Expected: Impl : (Future[Future](i32) Io : Io)`<br>`- Given   : Impl : (Future[Future](T) E : E)` |

Arm 65 itself (`scratchpad/t5/B_a65.test.yo`, extracted with `subset_arms.py`, wrapper kept): `1 passed` but **`hollow=1`** under sh172 **and** under P2. Its last `__DBG_FT` is the identical message with `Ctx` substituted for `Io`.

**The decisive measurement** (`scratchpad/t5/B_io_i64.yo` = the same file with `Future(i64, Io)`):

- **./yo-cli**: `Error: Incompatible return type: - Expected: i64 - Got: i32` — caret on the **closure**. TS bound `T := i64` from the annotation and pushed it into the closure body.
- **yo-self**: `Given` is _byte-identical_ to the i32 case — `Impl : (Future[Future](T) E : E)`. **The annotation has zero influence.** T and E are never bound.

## 2. ROOT

Two stacked gaps.

**B1 (real, fixed, but not arm 65's blocker)** — `yo-self/types/compatibility.yo:805-810`:

```rust
    // SomeT: name + frame_level identity (Phase 2f: no env resolution)
    .SomeT(name : aname, frame_level : alvl) => match(
      expected,
      .SomeT(name : ename, frame_level : elvl) => ((aname == ename) && (alvl == elvl)),
      _ => false
    ),
```

Two `Impl(...)` SomeTs minted at different frames are rejected. This _is_ `scratchpad/w4/w1.yo`'s bug (`Expected: Impl : (ToString)` / `Given: Impl : (ToString)`, genuinely identical strings, thrown from `yo-self/evaluator/exprs/assignment.yo:958`).

**B2 (arm 65's actual blocker)** — `io.async`'s return type is never resolved. `std/prelude.yo:8246`: `async : (fn(generic(T : Type, E : Type.Struct), action : Impl(Fn(e : E) -> T)) -> Impl(Future(T, E)))`. yo-self _has_ the pre-bind port (`yo-self/evaluator/calls/helper.yo:4553`, "Step 6b") and the adopt (`helper.yo:5224-5257`, "Step 10"), but the i64 probe proves neither takes effect: Step 9's `evaluate_function_return_type_again(ret_b, callee_env_m, ctx)` (`helper.yo:5184`) returns the raw declared `Impl(Future(T,E))`, and Step 10's guard

```rust
if(are_types_compatible(ret_for_adopt, et.ty) && !(type_contains_some_type(et.ty)), {
  return_type = et.ty;
});
```

is false, so the expected type is not adopted. `assignment.yo:958` then throws.

Even **with B1 fixed** the Step-10 compat is still false: the trait-subset recursion reaches `_compat_impl(FutureTraitT(T, E), FutureTraitT(i32, Io))` (`compatibility.yo:946-997`), whose output check `recur(SomeT T, i32)` has no way to resolve `T` — yo-self's `_compat_impl` takes **no `env`** ("Phase 2f: no env resolution"), and the effect-label match `al == el` compares `"E"` against `"Io"`.

## 3. TS MECHANISM

`src/evaluator/calls/helper.ts:1550-1607` — return-type adoption, verbatim excerpt:

```ts
const evalReturnTypeResult = evaluateFunctionReturnTypeAgain({
  functionType,
  calleeEnv,
  context: { ...context, isEvaluatingFunctionType: true },
  functionCalleeExpr,
});
returnType = evalReturnTypeResult.returnType;
calleeEnv = evalReturnTypeResult.calleeEnv;

if (
  areTypesCompatible(
    { type: context.expectedType.type, env: context.expectedType.env },
    { type: returnType, env: calleeEnv }
  ) &&
  !typeContainsSomeType(context.expectedType.type)
) {
  returnType = context.expectedType.type;
}
```

Made reachable by two things yo-self lacks:

- `src/evaluator/calls/helper.ts:1313-1365` — the `functionType.ioBuiltin === "io_async"` pre-bind that writes `T` and `E` into `calleeEnv` from `extractFutureTraitFromType(context.expectedType.type)`; yo-self's port at `helper.yo:4553` exists but does not reach the return type (measured).
- `src/types/compatibility.ts:916` — `const givenType_ = getValueOfSomeTypeFromEnv(given.env, given.type);` — **env-based** SomeType resolution, which resolves `T`/`E` off `calleeEnv` inside the nested Future-trait comparison. yo-self's `_compat_impl` has no env parameter at all.

And the SomeT-vs-SomeT rule B1 should mirror: `src/types/compatibility.ts:676-796` (`if (isSomeType(given.type))` → id equality, then requiredTraits-subset unification, then negatives, then `resolvedConcreteType`).

## 4. YO-SELF DELTA (anchors verified `grep -c == 1`)

| file:line                                | anchor                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `yo-self/types/compatibility.yo:805`     | `// SomeT: name + frame_level identity (Phase 2f: no env resolution)` — **1**                                   |
| `yo-self/types/compatibility.yo:808`     | `.SomeT(name : ename, frame_level : elvl) => ((aname == ename) && (alvl == elvl)),` — **1**                     |
| `yo-self/evaluator/calls/helper.yo:5184` | `(return_type : TypeValue) = evaluate_function_return_type_again(ret_b, callee_env_m, ctx);` — **1** (Step 9)   |
| `yo-self/evaluator/calls/helper.yo:5255` | `if(are_types_compatible(ret_for_adopt, et.ty) && !(type_contains_some_type(et.ty)), {` — **1** (Step 10 adopt) |

## 5. PROPOSED PATCH

**B1 only.** Full literal Yo is in `/Users/yiyiwang/Workspace/Yo/scratchpad/t5/patch_someT.txt` (98 lines) — a 1:1 port of `compatibility.ts:676-796`, replacing `compatibility.yo:805-810`. Applied to `scratchpad/t5/p2`, formatted with `./yo-cli fmt`, built to `/tmp/t5p2`.

Measured: `B_w1.yo` **rc=1 under P1 → rc=0 under P2**, 0 `Failed to transpile` markers, emitted C matches TS's shape. `check ./std` 0 errors; `basic` 33/33; `async_await` 116/116 — no regression.

**I have no patch for B2.** Do not attempt one from the compat side — the missing piece is env-carrying resolution, a structural change to `_compat_impl`'s signature. The correct next step is to fix Step 9 (make `evaluate_function_return_type_again` at `helper.yo:5184` see the `T`/`E` that Step 6b bound), which makes the adopt unnecessary.

**Direction caveat on B1:** `_compat_impl(actual, expected)` is called in _both_ orders in yo-self — `assignment.yo:958` passes `(variable.ty, rhs_type)` = (TS-expected, TS-given), while `helper.yo:5255` passes `(return_type, et.ty)` = (TS-given, TS-expected). My port treats the `expected` slot as TS's expected (matching the file's parameter names and its other SomeT rules, e.g. the `compatibility.yo:293` comment). This only matters when the two constraint lists differ in length; in both repros they are length 1, so the measurement cannot distinguish the directions.

## 6. BLAST RADIUS

`are_types_compatible` has **191** call sites, `are_types_compatible_exact` **28**. The port is strictly _more permissive_ than HEAD in one important way TS shares: two **unconstrained** SomeTs with different ids now compare equal **even under `require_exact`** (TS explicitly documents this at `compatibility.ts:698-706`). `are_types_compatible_exact` feeds specialization cache keys, so the realistic regression is **two distinct generic specializations merging into one**. Not observed in `check ./std` / basic / async*await, but those do not stress the specialization cache the way the compiler's own `imm*\*`/collections corpus does.

## 7. CONFIDENCE + cheapest settling observation

- B1 root + fix: **high** (repro flips, C matches TS).
- B2 localization ("`T`/`E` never bound, so the adopt never fires"): **high** — the i64 probe is decisive and refutes the verifier's "supposed to stay generic" claim, because TS demonstrably binds `T` from the annotation.
- Which of Step 6b / Step 9 is the _first_ divergence: **open**.

**Cheapest observation that settles it:** rebuild `scratchpad/t5/p3` with one `eprintln` right after `helper.yo:5184` printing `type_to_string(return_type)` gated on `is_io_async_call(expr)`, then `/tmp/t5p3 check scratchpad/t5/B_io_variant.yo`. If it prints `Impl : (Future[Future](T) E : E)` the bug is Step 6b/Step 9 (the bindings never reach the type-level walk); if it prints the concrete form, the bug is downstream in Step 10 / the assignment. One ~2.5-min build, one 5-second run.

---

## Artifacts

- Repros: `/Users/yiyiwang/Workspace/Yo/scratchpad/t5/{A_nom1,A_g4_min,A_tup13,A_tup13b,A_v1_rename,A_v2_nostruct,A_v3_structonly,B_w1,B_io_variant,B_io_i64,B_a65_ok}.yo`, `.../t5/{A_a12,B_a65}.test.yo`
- Patch text: `/Users/yiyiwang/Workspace/Yo/scratchpad/t5/patch_someT.txt`
- Patched trees: `/Users/yiyiwang/Workspace/Yo/scratchpad/t5/p1` (A1), `.../p2` (A1+A2+B1), `.../p3` (p2 + un-silenced swallow)
- Binaries: `/tmp/t5p1`, `/tmp/t5p2`, `/tmp/t5p3` (probe: prints `__DBG_FT` / `__DBG_AF` on every swallowed def-time throw), `/tmp/t5probe` (HEAD + un-silenced swallow)
- Nothing under `yo-self/`, `src/`, `std/`, `tests/` was modified (`git status` unchanged apart from the pre-existing `src/tests/fixme.yo`).
