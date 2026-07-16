# yo-self: user `impl Dispose` not wired into `dispose_fn` → transitively-freed containers leak ALL elements

## Status: FIXED (both parts landed together, all gates green, 2026-07-16).

`transitive_list_drop` → `tracked 100→0`; corpus PASS 126 / DIFF 1 (the 1 = the
unrelated ctor-arg divergence) / 0 crashes; `check ./yo-self` 303, `check ./std`
153; self-emit clang 0; **`s2 check empty_main` rc=0** (the earlier SIGSEGV is
gone). Two coupled fixes were required:

1. **Wire user `impl Dispose` into the synthesized `___dispose`** (the original
   fix — see "The fix" below).
2. **Key the `___dispose` by `type_key` (instantiation-precise), not the shared
   struct id** — the SECOND bug. HashMap(K,V) instantiations share ONE eval struct
   id, so keying dispose by that id registered ONE dispose (specialized for the
   first-seen V) and made EVERY HashMap instantiation reuse it. Once fix #1 made
   dispose active, `HashMap(usize, bool)` [`checked_indices` in
   `try_to_call_type_with_arguments`] ran the `HashMap(usize, EvalValue)` dispose
   and dropped its `bool` slot value `true`(1) as a reference → `__yo_decr_rc(0x1)`
   → SIGSEGV. Fix mirrors the Trace path exactly (register + look up under
   `type_key`): `collection.yo` `_eval_and_register_rc_method` registers under
   `type_key(ct)`, `_synthesize_and_register_dispose` guards on `type_key(ct)`, and
   `drop_dup.yo` `get_dispose_function_for_type` looks up by `type_key(type)`.

**Impact measured (parser.yo proxy):** live tracked objects 3.17M → 2.43M; s2 peak
RSS ~2.4G → ~1.66G. The dominant leaked type (Variable) dropped 2.67M → 1.99M.
This does NOT fully close the s2-vs-s1 gap (s1 = 478 MB / 360K Variables): a
SEPARATE, deeper leak remains — see "## REMAINING (separate) leak" below.

## Symptom / impact

Self-compiled yo-self (`s2`) uses **3.4× the memory of TS-compiled yo-self (`s1`)**
for the same compile: on `yo-self/parser.yo`, s1 peaks **477 MB**, s2 peaks **1633 MB**,
emitting byte-identical output. Live-object histogram at exit (parser.yo):
`s1` = 898 K tracked objects (dominant: Variable 360 K); `s2` = 3.17 M
(**Variable 2.67 M** — a ~7× gap). s2 allocates 2.65 M Variables via
`add_variable_to_env` and frees **≈0** of them. This is why `s2 compile
yo-self/main.yo` balloons past 16 GB and the self-hosting fixpoint can't complete
on a 16 GB box (see plans/YO_SELF_STAGE2_HANDOFF.md).

## Minimal repro (`tests/codegen-bootstrap/transitive_list_drop.yo`)

```rust
Inner :: ref(struct(x : i32, cyc : Option(Self)));   // cyclable → Gc.tracked_count sees it
Outer :: ref(struct(items : ArrayList(Inner)));
main :: (fn() -> unit)({
  (i : i32) = i32(0);
  while(i < i32(50), {
    o := Outer(items : ArrayList(Inner).new());
    o.items.push(Inner(x : i, cyc :.None));
    o.items.push(Inner(x : i, cyc :.None));
    i = (i + i32(1));                 // `o` dropped here → drop Outer → free items list
  });
  println(`tracked=${Gc.tracked_count()}`);
});
```

**TS-compiled → `tracked=0`. yo-self-compiled → `tracked=100`** (all 2×50 `Inner`
leak). Dropping `Outer` `decr_rc`s its `items` field; when the `ArrayList(Inner)`
rc hits 0 its `dispose_fn` runs — but yo-self leaves it **NULL**, so the buffer's
elements are never dropped.

Corpus misses this because corpus programs drop small structures at EXPLICIT drop
sites (inline element drop works); the leak only appears when a container is freed
**transitively** (as an RC field of another object whose dispose merely
`decr_rc`s the field). The compiler does this everywhere: Environment → frames
(`ArrayList(Frame)`) → each Frame's `variables` (`ArrayList(Variable)`) → Variables.

## Root cause (exact)

`std/collections/array_list.yo:555` defines `impl(forall(T), ArrayList(T),
Dispose(dispose: (fn(self) { ... Self._free_elements(self); free buffer ... })))`
— the RAII destructor that drops every element and frees the buffer. TS wires this
into the container's `dispose_fn`; yo-self does not:

- **yo-self `_synthesize_and_register_dispose`** (`codegen/functions/collection.yo:1045`)
  only walks STRUCT FIELDS and emits `(___drop)(field)` for RC-typed fields. For
  `ArrayList` the fields are `_ptr`(raw ptr)/`_length`/`_capacity` — none is
  `type_contains_rc_type` → `any=false` → early `return` → **no `___dispose`
  synthesized**. It NEVER consults the user `Dispose` impl. Then
  `get_dispose_function_for_type` (`codegen/exprs/drop_dup.yo:53`) finds no
  `___dispose` → the constructor emits `obj->header.dispose_fn = NULL`
  (`codegen/functions/constructors.yo:113-114`).
- **yo-self is missing the equivalent of TS `collectDisposeMethodsFromGenericImpls`**
  (`src/codegen/functions/collection.ts:650`), which specializes+registers the
  user `dispose` from generic impls like `impl(forall(T), ArrayList(T), Dispose)`.
  (yo-self HAS the exact analogue for Trace — `collect_trace_methods_from_generic_impls`
  — so the machinery pattern already exists to copy.)
- **yo-self is also missing the wiring in \_\_\_dispose generation**: TS's
  `generateFunction` (`src/codegen/functions/generation.ts:1433-1473`) calls
  `findUserDisposeMethodForType(SelfType)` (`generation.ts:129-175`) and emits
  `disposeInfo.cName(self); // Call user's dispose method` at the top of the
  \_\_\_dispose body.

## The fix (faithful port — 3 coordinated parts, mirror the existing Trace path)

1. **Collect + specialize the user `dispose` from generic impls** — port
   `collectDisposeMethodsFromGenericImpls` (collection.ts:650). Model it on
   yo-self's existing `collect_trace_methods_from_generic_impls`
   (collection.yo) — same `find_methods_from_generic_impls(concreteType, "dispose",
env)` → register under a c_name → collect its types + called functions. Call it
   from `codegen_c.yo` alongside the trace collection (~L239/245).
2. **Wire the user dispose into the synthesized `___dispose`** — in
   `_synthesize_and_register_dispose`, look up the concrete type's user `dispose`
   (from part 1); if present, prepend a call to it in the synthesized body and do
   NOT early-return when the field-walk is empty (ArrayList has no RC _fields_ but
   still needs the user-dispose call). Mirror TS generation.ts:1439-1472
   (incl. the pointer-cast when the dispose was specialized for a different C id).
3. **Ensure `get_dispose_function_for_type` then resolves** so the constructor
   stamps a non-NULL `dispose_fn` for ArrayList (and any Dispose-implementing type).

CAUTION (RC correctness): this adds real drops on the transitive-free path — run
the FULL gate cascade. New drops must not double-drop: verify the repro
(`tracked 100→0`), corpus (119 / DIFF 0 — the over/under-drop oracle), `check
./yo-self` 303, `check ./std` 153, self-emit clang 0. Then remeasure the proxy:
`s2 compile yo-self/parser.yo` peak RSS should fall 1633 MB → toward 477 MB.

## Tooling (reusable; in scratchpad + /tmp)

- Live-object histogram by `dispose_fn` (dladdr-resolved): `scratchpad/patch_hist.py`
  patches a stage2 emit's `__yo_process_cleanup` to walk `__yo_all_thread_gcs →
tracked_objects` at exit. Build with `clang -O1 -g ... -ldl`.
- Alloc-site histogram: patch the type's `__yo_new` to record
  `__builtin_return_address(0)` (named `add_variable_to_env` as the 99% source).
- Proxy measure: background `s2 compile yo-self/parser.yo --emit-c` + poll
  `ps -o rss=` on the `/tmp/s2r6 compile` worker PID (NOT the zsh wrapper).

```

## SECOND BUG (blocker) — HashMap value = garbage 0x1, unmasked by wiring dispose

With the fix applied, `s2 check tests/codegen-bootstrap/empty_main.yo` crashes
(SIGSEGV) during prelude. Backtrace (via a patched `__yo_decr_rc` that `backtrace()`s
when `ptr < 4096`, on an `-O1 -g -rdynamic` build of the fixed stage2.c):

```

[BADPTR decr_rc ptr=0x1]
#1 yo_id_405599 ← the container's **\_dispose (= my synthesized `self.dispose()`)
#3 yo_id_256983 ... ← normal eval path (NOT gc_collect), frame 15 = **yo_user_main

```

`yo_id_405599` disposes `__yo_t466` = `HashMap` (Swiss table: `ctrl,data,capacity,
size`) with entry `struct { size_t key; __yo_t65* value; }`, where `__yo_t65` =
**EvalValue** (ref enum). The emitted user-dispose loop is CORRECT — it reads the
ctrl byte, checks `!= 255 (CTRL_EMPTY) && != 254 (CTRL_DELETED)`, and only drops
`(*bucket_ptr).value` on occupied slots (matches std/collections/hash_map.yo:449
Dispose). So the crash is a genuinely OCCUPIED slot holding a dangling/garbage
`EvalValue*` (0x1) — a pre-existing RC-ownership bug in how that `HashMap(usize,
EvalValue)` stores/keeps its values (a value stored without a proper dup, or
dropped by another owner leaving the map's slot dangling; 0x1 = freed-then-reused
memory). It was INVISIBLE until now because the map's dispose never ran
(dispose_fn was NULL → the whole map's values leaked). This is the same RC-parity
family as the historical HashMap.set-overwrite leak (issues/... fixed) but on a
different map/insert path.

Corpus is blind to it (corpus programs don't build+dispose a `HashMap(usize,
EvalValue)` with the offending insert pattern; only the compiler's prelude does).

### Next step to land the fix
1. Identify WHICH `HashMap(usize, EvalValue)` in the evaluator holds the 0x1 value
   and its insert site (candidates: a value/eval cache keyed by a usize id). Trace
   with the patched-`decr_rc`-backtrace build (`/tmp/stage2_bt` recipe above) — or
   instrument the map's `set`/`insert` to assert the value pointer is a live header.
2. Fix the ownership: the map must `___dup` the EvalValue on insert (own its slot),
   OR the double-owner must not drop it. Mirror the TS insert path (TS's s1 keeps
   these values live — its map dispose runs fine).
3. Re-apply the collection.yo fix (documented above) + re-run the full gate:
   repro `tracked 100→0`, corpus (expect DIFF 1 = the ctor-arg one only, 0 crashes),
   checks 303/153, self-emit clang 0, s2 `check empty_main` rc=0, then the proxy
   `s2 compile yo-self/parser.yo` peak RSS 1633MB → ~477MB.

### The reverted fix (re-apply verbatim in `_synthesize_and_register_dispose`,
`yo-self/codegen/functions/collection.yo`)
- After the `___dispose`-already-registered guard, add:
  `has_user_dispose := (find_methods_from_generic_impls(ct, "dispose", module_env).len() > 0)
   || (get_type_trait_methods_by_name(type_id_or_empty(ct), "dispose").len() > 0);`
- Change the empty-field-walk early return to `if(!(any) && !(has_user_dispose)) return;`
- Build the body: prepend `self.dispose(); ` when `has_user_dispose`, then the
  existing `{ destructs } := self; <drops>` only when `any`, then `()`.
(Full rationale in the git history of this session / the fix section above.)

## REMAINING (separate) leak — ~1.6M Variables still leak on parser.yo

After the two fixes above, `s2 compile yo-self/parser.yo` still holds **1.99M live
Variables** (vs s1's 360K) in ~75K Environments (~26 vars/env — implausibly high
for real scopes). So most leaked Variables are NOT reachable via the live
Environments; they are orphaned. The container-dispose chain (Environment → `frames`
`ArrayList(Frame)` → Frame → `variables` `ArrayList(Variable)` → Variable) now
disposes correctly ONLY when the owning Environment/Frame actually reaches rc 0.

Hypothesis for the next round: **Environments/Frames don't reach rc 0** (or Frames
are popped from `env.frames` without being dropped) — a scope-exit / env-lifecycle
RC gap, distinct from container dispose. Candidate sites: `ArrayList(Frame)` pop on
scope exit (does the popped Frame get dropped?), callee-env teardown on function
return, and the `expr_info_table` `ExprInfo.env` retention. Measure with the live
histogram (`scratchpad/patch_hist.py` pattern; Variable dispose id + Environment
dispose id) and the alloc-site histogram (`__yo_new` of Variable/Environment/Frame
→ `__builtin_return_address(0)`). This is the next lever toward the 16 GB fixpoint.
```
