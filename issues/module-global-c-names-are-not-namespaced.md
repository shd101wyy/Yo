# Module-level globals get unmangled C names, so same-named globals in different modules alias

**Found 2026-08-05** while fixing
`issues/fixed/module-global-c-name-collision-leak.md`. That issue was one _instance_; this
is the underlying compiler behaviour, which is unchanged and will bite again.

## The behaviour

A module-level variable is emitted with its Yo name as the C identifier, with no module
qualifier:

```c
static __yo_struct_yo74961700_id_2996* g_control_fn_registry; // module-level mutable variable
```

Compare every other emitted identifier, which _is_ module-qualified — types
(`__yo_struct_yo74961700_id_2996`), functions (`fn_yo67df6aba_id_145_…`), and temporaries
(`_yoebec35a0_temp_275987`) all carry a `yoXXXXXXXX` module hash.

So if two modules each declare a module-level global with the same name, they become **one
C variable**. There is no diagnostic. Consequences, in increasing severity:

1. One initializer's allocation is orphaned → a leak (what LeakSanitizer caught).
2. The two modules **share state** they each believe they own. Writes through one are
   visible through the other.
3. Initialization order decides which value survives, so behaviour depends on module
   ordering.

In the instance found, (2) was actually _load-bearing_: the evaluator wrote through one
module's registry and the codegen read through the other's, and it only worked because they
aliased. Fixing the aliasing without noticing that would have silently broken
control-function handling in the self-hosted compiler.

This is not yo-self-specific. Two ordinary Yo modules that both declare
`(g_cache : HashMap(String, i32)) = …` will alias in exactly the same way.

## Repro sketch

```rust
// a.yo
{ HashMap } :: import("std/collections/hash_map");
(g_cache : HashMap(String, i32)) = HashMap(String, i32).new();
a_put :: (fn() -> unit)({ g_cache.set(`k`, i32(1)); });
export(a_put);

// b.yo — same global NAME, logically a different variable
{ HashMap } :: import("std/collections/hash_map");
(g_cache : HashMap(String, i32)) = HashMap(String, i32).new();
b_len :: (fn() -> usize)(g_cache.len());
export(b_len);

// main.yo
{ a_put } :: import("./a.yo");
{ b_len } :: import("./b.yo");
// a_put() then b_len() should observe 0 (separate variables) but observes 1,
// and one of the two HashMaps is leaked.
```

Note a runtime module-level variable **cannot be exported**
(`Variable "g" is not a compile-time variable and cannot be exported.`), which is precisely
why two modules needing the same registry are tempted to declare it twice — as
`yo-self/` did.

## Options

1. **Mangle module-global C names per module**, like every other emitted identifier
   (`g_cache` → `g_cache_yoXXXXXXXX`, or reuse the existing module-prefix scheme). This is
   the consistent fix and it is invisible to users, since the C name is internal. It would
   have to be applied in both compilers, and it _changes behaviour_ for any code that is
   currently (accidentally) relying on the aliasing — so land it with a sweep for
   duplicate names first.
2. **Reject the collision at compile time.** Cheaper and strictly an improvement in
   diagnosis, but it forbids a legal program (two modules genuinely may want same-named
   private globals), so it is a stopgap rather than a fix.
3. Do (2) now and (1) later — the diagnostic is what turns a silent miscompile into a
   build error, which is the important part.

Emission sites to change for (1): the module-global declaration and its assignment in
`src/codegen/functions/generation.ts` (the `// module-level mutable variable` declaration
and the `__yo_main_module_init` body), plus the read path wherever a module-level variable
name is resolved for codegen — and the yo-self mirrors.

## Guard that exists today

None in the compiler. There is a tree-level audit that can be re-run cheaply over
`yo-self/`:

```bash
find yo-self -name '*.yo' -type f | while read f; do
  grep -nE '^\([A-Za-z_][A-Za-z_0-9]*\s*:' "$f" | sed "s|^|$f:|"
done | sed -E 's/.*:\(([A-Za-z_][A-Za-z_0-9]*).*/\1/' | sort | uniq -d
```

It currently reports nothing (181 globals, 181 distinct names). A CI step running this over
`yo-self/` and `std/` would catch a regression until option 1 or 2 lands.
