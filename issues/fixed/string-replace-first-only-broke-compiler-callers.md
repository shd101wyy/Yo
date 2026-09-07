# `String.replace` replaced only the FIRST occurrence, and four compiler call sites assumed otherwise

**Status:** FIXED by D10 (`plans/STD_API_STABILIZATION.md` §2) — `String.replace`
and `ImmString.replace` now replace EVERY occurrence, so these call sites became
correct without being touched.

## The shape of the defect

`String.replace(pattern, new)` replaced the first match only, under the name
every Rust, Python, Go and JavaScript user reads as replace-all. Nothing in the
call site says which it is, so a caller that means "normalize all of these"
compiles, runs, and is silently wrong on any input with two matches.

The tell is in the tree itself: `std/path.yo:64` normalizes Windows separators
with `replace_all`, while `src/main.yo:475` and `src/expr_info.yo:883` do the
**same operation** on the **same kind of value** with `replace`. Same intent,
two spellings, one of them wrong.

## Live defects (reachable today)

1. **Windows path separator normalization stops after the first backslash.**
   - `src/expr_info.yo:883` — `module_path.replace("\\", "/")`
   - `src/expr_info.yo:892` — `base.replace("\\", "/")`
   - `src/main.yo:475` — `joined.replace("\\", "/")`

   `C:\proj\src\main.yo` normalized to `C:/proj\src\main.yo`. Windows-only, which
   is why it survived: the macOS and Linux legs never produce a backslash.

2. **`/./` collapsing stops after the first segment.**
   - `src/expr_info.yo:904` — `p.replace("/./", "/")`

   `a/./b/./c` collapsed to `a/b/./c`.

3. **The "whitespace-stripped" pragma scan strips one space and one tab.**
   - `src/main.yo:2585`, `src/main.yo:2620`

   The comment states the intent outright — *"Whitespace-stripped `contains` ==
   the TS regex's arbitrary intra-call whitespace tolerance"* — and the code
   does not do it. `pragma( Pragma.SkipWasm )` written with more than one space
   did not match the needle, so the skip was ignored and the test RAN on a wasm
   target instead of being skipped.

## Latent defect (not reachable today)

4. **`_ti_escape_str` escapes only the first backslash and the first quote.**
   - `src/evaluator/builtins/type_fns.yo:623-625`

   It builds Yo source to be re-evaluated, so an unescaped `"` would produce
   broken generated source. Every caller (lines 767, 814, 898, 964, 988, 1067,
   1246, 1782) passes a struct field label, enum variant name, param label or
   struct type name — all Yo **identifiers**, which cannot contain `"` or `\`.
   So the function is wrong but currently unreachable with input that shows it.
   Recorded because the next caller need not obey that.

## Explicitly NOT a defect

`src/evaluator/types/enum.yo:205` and `src/evaluator/types/struct.yo:81`
sanitize a module path into a decl key with
`.replace("/", "_").replace(".", "_").replace(":", "_")`. Replacing only the
first separator looks wrong, but it does not introduce collisions that
replace-all avoids — `a/b.c` and `a.b/c` map to the same key under BOTH
semantics. The flip makes the key cleaner, not more correct.

## The other 8 call sites are unaffected

`build_runner.yo:542`, `check_watch.yo:83`, `module_manager.yo:446`,
`import.yo:372` strip a `file://` prefix that occurs once;
`comptime_fn.yo:102,103,205,206` strip a `__self_shell` marker. One occurrence
means first and all agree.

## Fix

D10 flipped the semantics rather than patching the call sites:
`replace` = all, `replacen(pat, to, n)` = bounded, `replace_first` kept for one
release as the deprecated old meaning. All four live sites wanted replace-all,
and **no** call site in `std/`, `src/` or `tests/` genuinely wanted first-only —
which is itself the evidence that the name was wrong, not the callers.
