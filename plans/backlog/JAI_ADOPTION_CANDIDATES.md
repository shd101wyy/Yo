# What to take from Jai: adoption candidates checked against the tree

**Status: BACKLOG — research, written 2026-11-15 at the maintainer's
request ("audit whether there is anything we could adopt from Jai", for
after VBD).** The Jai member of the candidate catalogues
([`ZIG_ADOPTION_CANDIDATES.md`](ZIG_ADOPTION_CANDIDATES.md),
[`RUST_ADOPTION_CANDIDATES.md`](RUST_ADOPTION_CANDIDATES.md)), with the same
filter (§0 of the Rust document) and the same discipline. Nothing here is
adopted; each candidate ends with a verdict and a trigger, and the catalogue
is pull-only (`POST_VBD_PLAN.md` rule 4).

**Sources and their limits.** Jai is a closed beta with no public reference.
The Jai claims below were read on 2026-11-15 from the Jai Community Library
wiki (its Getting Started, Advanced, Metaprogramming and Modules pages); a
Jai claim marked *(from memory)* is not on those pages and comes from talks
and beta notes. Every "Yo today" claim was checked by grep on develop
`e3c456200` (2026-11-15); a claim marked *(verify)* was not run to ground and
the adopting PR must.

## 0. The verdict

Jai and Yo share one thesis, compile-time execution over types as values,
and Yo already has it in a stricter form. On the three axes where Jai is
most distinctive, Yo has decided the other way on the record:

| Jai's choice | Yo's ruling |
| --- | --- |
| an implicit `context` (allocator, temporary storage, logger) passed to every procedure | dynamic scoping, rejected: `ALLOCATOR_PLACEMENT.md` §8 item 8; allocators are placed by argument |
| code-splicing metaprogramming (`#insert`, `#code`, `#expand` macros) | the macro layer is deleted; "exprs are data; two doors make code" (`COMPTIME_METAPROGRAMMING_AUDIT.md` §0) |
| manual memory, pointer arithmetic, no captures | ownership, origins, `Rc`/`Arc` (VALUES_BY_DEFAULT) |

So the audit is short. **Two things are worth taking, one finding corrects
an existing plan, and five are positions or riders on candidates other
documents own:**

| # | Candidate | Verdict |
| --- | --- | --- |
| J1 | a compiler-emitted call chain (Jai's `Stack_Trace_Node`): stack traces on every target, with no libc and no debug info | **adopt**, medium |
| J2 | arena mark/release and a high-water mark (Jai's temporary storage, without the ambient part) | **adopt as a rider** on `ZIG_STYLE_ALLOCATORS.md` A4, small |
| J3 | `#caller_location` is a separate directive from `#location` | **corrects C6**: `source_location()` cannot be a `?=` default as C6 writes it |
| J4 | `enum_flags` | fold into Z13 as two acceptance criteria |
| J5 | notes on struct members, read by metaprograms | adopt the need as typed **derive options**, on the first consumer |
| J6 | registries generated from tagged declarations | no new feature: `TypeInfo.Module` + C8; make it a C8 gate |
| J7 | the compiler message loop ("house rules") | reject the mechanism; park the need under `yo gate` |
| J8 | module parameters | verify first; a position if the gap is real |

## 1. Where Yo and Jai already agree

Listed so nobody proposes it again:

| Jai | Yo today | Where |
| --- | --- | --- |
| `$T` polymorphic procedures, `struct(T: Type)`, `Type` as a value | `comptime(T) : Type`, `generic(T)`, type constructors as comptime functions | `COMPTIME_METAPROGRAMMING_AUDIT.md` §1.2 |
| `#run` computing constants, `#assert`, `#if` | CTFE over the whole language, `comptime_assert`, comptime `cond` over `platform` | same, §1.3; `yo-design` "Platform-specific code" |
| `#bake_arguments` | `_` partial application of a comptime-returning callee | `yo-design` "Partial Application with `_`" |
| `$T/interface`, and `#modify` used to accept or reject a call | traits and `where(T <: Trait)` bounds | `docs/en-US/DESIGN.md` |
| `type_info(T)` at compile time | `TypeInfo`, `Type.get_info()` | `plans/reference/TYPE_REFLECTION.md` |
| `#insert` of a generated declaration string | `comptime_eval` (declarations only), `comptime_str.to_expr()` | `COMPTIME_METAPROGRAMMING_AUDIT.md` §2 |
| the build is a program (`#run build()`, workspaces, `set_build_options`) | `build.yo`, comptime over the `__yo_build_*` builtins | `plans/reference/BUILD_SYSTEM.md` |
| `#foreign`, `#library`, the Bindings Generator | `c_include(...)` / `extern(...)` as module values | `plans/reference/C_INCLUDE_EXTERN_MODULE_VALUE.md` |
| `#asm` | `asm(...)` | `docs/en-US/INLINE_ASSEMBLY.md` |
| member defaults (`a: s64 = 0`), default arguments, named arguments | `(b : i32) ?= i32(9)` on fields and parameters, labelled arguments | `docs/en-US/DESIGN.md` "Default parameter values"; `tests/struct_missing_field.test.yo:13` |
| multiple return values | tuples and destructuring | `yo-syntax` |
| `#must` | E0617 on a dropped `Result` or an unawaited `Future` (#1075) | `plans/archive/ATS_LESSONS_BEYOND_INDEXED_TYPES.md` §A2 |
| `#complete` on an `if`-`case` | `match` is exhaustive, always | `plans/reference/MATCH_PATTERN_MATCHING.md` |
| `[N]T`, `[]T`, `[..]T`; `string` as a view that is not zero-terminated | `Array(T, N)`, `[T]`, `ArrayList(T)`; `str` | VALUES_BY_DEFAULT decision 49 |
| a distinct type over an existing one *(from memory: `#type,distinct`)* | `newtype(...)` | `docs/en-US/DESIGN.md` "Newtype" |
| `#scope_file`, `#scope_export` | `export(...)`, the enforced `_` prefix | `plans/reference/MEMBER_VISIBILITY.md` |
| `Math :: #import "Math"` | `m :: import("m")`, `{ a, b } :: import("m")` | `yo-syntax` "Module imports" |
| `Any` | `Dyn(Trait)` and `TypeId` | `plans/reference/ERROR_TRAIT_AND_TYPEID.md` |
| `#this` for recursion | `recur` | `yo-syntax` |
| `ifx` | `cond` is an expression | — |
| `#compile_time` | impls bounded `where(Self <: Comptime)` | `yo-design` "Comptime/runtime function specialization" |
| the memory debugger in `Basic` *(from memory)* | `--allocator debug` (Z11, #1580) | `ZIG_ADOPTION_CANDIDATES.md` Z11 |

Jai is also a second data point for candidates other documents already
hold. None of these is restated here:

| Jai | Owned by |
| --- | --- |
| `defer` | Z1 (adopt, after the flip). Jai's is scope-exit in reverse order, the shape Z1 chose |
| `#string` here-documents | `RAW_AND_FENCED_STRING_LITERALS.md` |
| struct-of-arrays | `LANGUAGE_FEATURE_CANDIDATES.md` §6. The wiki now presents `SOA(T, count)` as a pattern generated with `#insert`, not a layout keyword, which is the "std, not a keyword" choice §6 made |
| `#no_abc`, `#no_aoc` (bounds and overflow checks off) | Z10 and `SAFE_MODE.md`: a scoped form, if a knob is ever added |
| `#align`, `#no_padding`, `#place`, `#overlay` | Z5 (packed structs and alignment, one design) |
| `break label`, `continue label` | `RUST_ADOPTION_CANDIDATES.md` L3 |
| a `#run` result baked into the program as a struct or an array | `COMPTIME_METAPROGRAMMING_AUDIT.md` C4 (promotion of aggregate returns) |

## 2. Candidates

### J1. A compiler-emitted call chain — Jai's `Stack_Trace_Node`

Jai, from the wiki: "every time a procedure is called, code is generated to
output a `Stack_Trace_Node` on the stack and link it up", and the node is
unlinked on return. The chain's head lives in the context, so
`print_stack_trace(context.stack_trace)` walks it. It is on by default and
"can be turned off for release builds"; the stated consumers are profilers
and memory debuggers.

**Yo today.** A panic prints its message with `file:row:col` and aborts,
with no stack (`RUST_ADOPTION_CANDIDATES.md` T5). Three open items want a
chain, and each is stuck on its mechanism:

- **T5** adopts `YO_BACKTRACE=1` through glibc's `backtrace()` and
  `backtrace_symbols_fd`, with "nothing on wasm". musl has no `backtrace()`
  either, and Yo's Linux release is static musl. `NO_LIBC_BY_DEFAULT.md`
  P9 then removes libc on Linux altogether, and that plan does not mention
  backtraces *(grep)*. So T5's mechanism covers neither the release binary
  nor the planned default.
- **Z11** shipped `--allocator debug` with the leak table naming a block by
  allocation number, its sites "deferred: need Z4". One `source_location`
  would name the line inside std that called the allocator. A leak report
  needs the caller's chain.
- **Z2** (error return traces) has no `try` to hook, because the macro
  removal rejects it.

**Why Jai's mechanism is the one that fits.** Yo emits C, so the chain is
three lines of C per function, and it is the same three lines on every
target: no unwinder, no symbolizer, no frame pointers, no debug info.

```c
// emitted only under the trace profile
static const __yo_fn_info __yo_info_parse = { "config.parse", "src/config.yo", 12 };
Config __yo_fn_parse(String src) {
  __yo_frame f = { __yo_trace_top, &__yo_info_parse }; // __yo_trace_top is thread-local
  __yo_trace_top = &f;
  /* body */
  __yo_trace_top = f.prev; // on every exit path, where the scope's drops already go
  return r;
}
```

```text
panic: index 7 out of bounds (len 3) at src/table.yo:41:9
  in table.get         src/table.yo:38
  in resolve_symbol    src/resolve.yo:112
  in main              src/main.yo:9
```

- **Consumers.** `__yo_panic` prints the chain. `--allocator debug` stores
  the top K `__yo_fn_info` pointers in its block header and prints them in
  the leak table, which closes Z11's deferred sites. `yo test` prints it
  under a failed assertion. Z16's panic handler receives it.
- **Deterministic output.** The chain is names and definition lines, with no
  addresses, so a cli-case golden can pin it. A symbolized backtrace cannot
  be pinned.
- **Async.** A resumed state machine pushes on entry and pops on suspend, so
  the chain is "who resumed this task", which is the true stack. The task's
  logical caller is not on it, and the output should say so.
- **Cost.** One thread-local load and two stores on entry, one store on
  exit, and it blocks the C compiler from inlining through it. So it belongs
  to a profile, not to every build: on for `--optimize 0`, `yo test` and
  `--allocator debug`, off otherwise, with a flag to force either way. Jai
  makes the same split.
- **Relation to T5.** T5 stays for optimized binaries on the platforms that
  have an unwinder. J1 is the debug-profile answer everywhere.

**Verdict: adopt, medium** (codegen on every exit path, async state machines
included; one runtime printer). It shares C6's `SourceLocation` for the node.
**Trigger:** Z11's allocation sites, or NO_LIBC P2 (console and panic
output), whichever comes first. Gate: the measured cost on a stage-2
`check ./src` built with the profile on, stated in the PR, after P-PERF-0.
Tests: panic inside nested calls, inside a closure, inside a resumed task,
on a second thread, and after an `unwind` popped frames.

### J2. Arena mark/release and a high-water mark — temporary storage without the ambient part

Jai's temporary storage is a linear allocator that the program resets as a
whole (`reset_temporary_storage`, typically once per frame).
`auto_release_temp()` sets a mark, and everything allocated after it is
released when the scope exits. The storage records a `high_water_mark`. On overflow a
debug build falls back to the heap, and the wiki says a release build "might
crash, or have memory corruption problems".

**Yo today.** std ships no arena (`std/arena` was deleted 2026-10-24).
`ZIG_STYLE_ALLOCATORS.md` plans `ArenaAllocator` (A3, three reset modes) and
the origin arena (A4, §4). Neither has a mark, and neither reports usage
*(grep: no mark, scratch or high-water in that plan)*.

**What to take.**

- **A mark is a child place.** `m := arena.mark()` yields a value whose
  allocations carry `m`'s origin, and dropping `m` restores the bump
  pointer. The static half is then free: a `&(T, m)` that outlives `m` is
  the E0911 that A4 already gives `reset`. The dynamic half is one check, an
  allocation made straight from the parent while a mark is open, which the
  release would free under its holder. A3 already panics on
  reset-while-live, and this is the same class.
- **A high-water mark** on both arenas, and one line for each arena in the
  `--allocator debug` exit report. Jai's point is operational: a scratch
  arena is sized once, from a measured peak.
- **The frame loop as a documented idiom**, because here Yo is strictly
  better than Jai. A stale temporary pointer in Jai is silent corruption;
  in Yo the `reset` at the loop head does not compile while one is live.

```yo ignore
mut(scratch) := Arena.new(PAGE_ALLOCATOR);
while(running, {
  frame(&scratch, &world);          // every &(T, scratch) dies inside the call
  scratch.reset(.retain_capacity);  // E0911 if one did not
});

path := {
  m := scratch.mark();              // a child place
  parts := split(&src, &m);         // -> View(str, m)
  join(&parts).to_owned()           // copied out; m dropped, bump pointer restored
};
```

**What not to take.** The ambient form: `context.temporary_storage`, `temp`
as an allocator any procedure can reach, `tprint`, and the `,,` operator
that pushes an allocator for one call. All of it is the dynamic scoping
ALLOCATOR_PLACEMENT rejected. The arena is an argument. Jai's fixed-size
storage with undefined overflow is also out: A3/A4 grow by chunk.

**Verdict: adopt as a rider on A4, small.** Trigger: A4.

### J3. `#caller_location` is not `#location` — a correction to C6

Jai has two directives. `#location` is the site of the code it is written
on. `#caller_location` is a default argument value and is the call site;
`Basic` declares
`assert :: inline (arg: bool, message := "", args: .. Any, loc := #caller_location);`.

**Yo today.** C6 (`COMPTIME_METAPROGRAMMING_AUDIT.md`, from Z4) has one
builtin, `source_location()`, "folded where it is written", and states that
"a defaulted parameter `loc : SourceLocation = source_location()` gives an
assert or log helper its caller's site". Those two sentences contradict each
other under the landed default-parameter rule (`docs/en-US/DESIGN.md`
"Default parameter values"): a default is recorded "once, where the function
is defined", names in it "resolve where the function is defined, not where
it is called", and a default that needs a call is E1105. As written, the
default is either an error or the helper's own signature line, for every
caller.

**The two ways out.**

1. One builtin, with a special case: `source_location()` in a `?=` default
   is evaluated at each call. That is one spelling with two meanings chosen
   by position, and it makes the default-parameter rule say "except this
   builtin".
2. Jai's split: `source_location()` is always the site where it is written,
   and `caller_location()` is legal only as a `?=` default (an E-code
   anywhere else) and is filled at each direct call.

**Verdict: take the split.** It keeps both rules exact, and the name at the
definition tells a reader what the parameter receives. C6 must also say what
a call through a function value passes. A function type carries no defaults,
so the parameter is explicit there, and a wrapper forwards its own `loc`.
This is a design input to C6, not a separate PR.

### J4. `enum_flags` — two acceptance criteria for Z13

Jai's `enum_flags u32` gives each member one bit, combines with `|`, and
prints a value as its member names.

**Yo today.** Flag words are raw integers. `OpenOptions.to_flags` returns
`Result(i32, String)` and ors `O_APPEND` into an `i32`
(`std/fs/types.yo:230`), `std/sys/fallocate.yo` keeps `FALLOC_FL_*` as
`i32` constants, and regex flags travel as a string. Z13's `EnumSet` is the catalogued answer.

**What Jai adds to Z13.** Two requirements it does not state. First, the bit
of each variant must be controllable, because the consumers are FFI words
(`O_*`, `FALLOC_FL_*`); that is `RUST_ADOPTION_CANDIDATES.md` L8's explicit
discriminants, which Z13 already waits on. Second, `Debug` prints the set as
variant names.

**Verdict: fold into Z13** as its acceptance criteria: `EnumSet(E).to_bits()`
and `from_bits` agree with the C constants for `OpenOptions`, and the
`Debug` output names the variants. No keyword.

### J5. Notes on members → typed derive options

Jai tags a procedure, a struct or a struct member with `@note`; a
metaprogram reads `decl.expression.notes` and compares the text. Notes are
free strings, and a misspelled one is silently ignored.

**Yo today.** A derive receives `(T, ctx, trait_params)`, where
`trait_params` are the trait's own type arguments (`std/prelude.yo:8695`
splices them into `Eq(...)`), and `TypeFieldInfo` is `(name, field_type)`
(`std/prelude.yo:7963`). There is no channel for per-field configuration, so
`derive(T, ToJson)` cannot rename or skip a field *(grep: no rename or skip
in `std/encoding/json.yo`; verify by trying)*.

**Position.** The need is real and the Jai shape is wrong for Yo. Options
belong at the `derive` call, as a typed comptime record that the derive
function receives and validates: an option naming a field the type does not
have is a compile error, and one field can be named differently by two
derives without collecting annotations. A note on the field is a new
syntactic category whose content nothing checks.

**Verdict: adopt on the first consumer, small to medium**, designed in
`plans/reference/DERIVE_TRAITS.md`. The likely first consumers are JSON
rename/skip, and a struct-driven argument parser for `std/cli` (Jai's
`Command_Line` module does this from type info *(from memory)*; Rust's
`clap` derive is the same idea), which would also want a field's doc comment
as help text. That last part is reflection surface, parked with C9 until the
consumer exists.

### J6. Registries from declarations — a C8 gate, not a feature

The Jai idiom: tag procedures `@Command`, and let the build metaprogram
collect them from the typechecked stream and generate the dispatch table.

**Yo today.** `TypeInfo` has a `Module(fields)` variant
(`plans/reference/TYPE_REFLECTION.md:74`), so a module's exports are
reflectable, and C8's `comptime_for` walks a `ComptimeList`. Membership in a
module is then the tag: "every export of `commands` whose type is
`fn(args : &Args) -> Result(unit, AnyError)`" is the registry, with no
notes and no message loop. Whether the walk can reach an export's *value*
from its reflected name (a member access by a comptime name) is
*(verify)*; if it cannot, that access is the gap to file.

**Verdict: no new feature.** Add "a command table generated from a module's
exports" to C8's gate tests, since it is the consumer that proves C8 and
module reflection compose.

### J7. The compiler message loop — "house rules"

A Jai build metaprogram calls `compiler_begin_intercept`, loops on
`compiler_wait_for_message`, receives every declaration as it is
typechecked, and may report errors (`compiler_report`) or add code
(`add_build_string`). The wiki: "The compile-time metaprogram can be used to
enforce house rules", with a MISRA check as its example.

**The need is stronger in Yo than in Jai.** Yo's authors are agents: a rule
that fails the build is obeyed, and a rule in `AGENTS.md` prose is
forgotten. Today the project's own house rules are shell scripts over text
(`scripts/check-issue-refs.sh`, the grep gates).

**The mechanism does not fit.**

- It is push-based and whole-program. The stream of "everything typechecked"
  forces eager checking, against demand-evaluated top-level bindings
  (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`) and against the resident
  `--watch` checker, which re-forces only edited definitions.
- `add_build_string` from inside the loop is a third door for code.
- Arbitrary user code runs inside every `yo check`, the editor's included.

**Position.** A house rule is a query over facts the compiler already
exports, run outside it. `yo context --format json` and `yo doc --format
json` carry the API index today. What body-level rules need and nothing
exports is a uses index ("which definitions reference `X`"), which the LSP's
references feature already computes. **Verdict: reject the message loop;
park the need** under `yo gate` (`BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`,
unstarted) as project-declared checks. Trigger: the next grep gate that
needs a semantic fact a regular expression gets wrong.

### J8. Module parameters

Jai: a module declares `#module_parameters`, and the importer sets them:
`#import "Module" (VERBOSE=true);`.

**Yo today.** For a library the language already has it. A parameterized
module is a comptime function that returns a record of declarations, and the
importer calls it. For the *root* program there is no channel: `build.option`
is readable only in the build file (`std/build.yo:420`), the environment
reader says why ("an ordinary module that read the environment would mean
something different under `yo build`, `yo check`, `yo test` and the editor",
`std/build.yo:427`), and `Executable` has no field that hands a value to the
root module. `RUST_ADOPTION_CANDIDATES.md` T6 rejected manifest features
because "`-Dname=value` plus comptime `cond` is the same mechanism", but no
`-D` value reaches a module's `cond` short of the build file choosing a
different `root` *(verify)*.

**Verdict: verify first.** If the gap is real, the position is Jai's own
rule, the importer passes the parameters, applied to the artifact: an
explicit `options` record on `Executable`, visible to the root as a comptime
module, with a mandatory default for every option, so that `yo check` and
the editor evaluate the defaults and mean one thing. Trigger: the first
package that needs a build-time switch.

## 3. Rejected

| Jai feature | Why not |
| --- | --- |
| `context`, `push_context`, `#add_context`, `,,` | dynamic scoping: `ALLOCATOR_PLACEMENT.md` §8 item 8. A handler-shaped need is an algebraic effect, which is in the signature |
| ambient temporary storage (`temp`, `tprint`) | the same; J2 keeps the arena and drops the ambience |
| `#insert` in expression position, `#code`, `#expand` macros, backtick names, `for_expansion` | the macro layer, deleted by `MACRO_AND_ISO_REMOVAL.md`; a general splice is the third door `COMPTIME_METAPROGRAMMING_AUDIT.md` rejects |
| `#run` that does arbitrary I/O and calls foreign code (the wiki's test example runs `run_command` under `#run`) | CTFE has no runtime storage, no extern calls, and file reads sandboxed to the package root; `yo check` and the editor run it on every edit. Build steps are where commands run |
| runtime `Type_Info`, and `print` of any value with no opt-in | reflection is comptime-only, so a binary carries no type tables; `derive(T, Debug)` is the opt-in, and with no orphan rule (`plans/reference/TRAIT_COHERENCE.md`) a foreign type can be derived locally *(verify)*. If the missing-`Debug` error lacks a `yo fix` repair, that repair is the improvement |
| `using` on members and parameters, `#as` | names that appear with no declaration at the use site; composition is a named field. Zig's `usingnamespace` was rejected for the same reason |
| `---` (explicitly uninitialized) | `ZIG_ADOPTION_CANDIDATES.md` §4, `undefined` |
| `xx` autocast, `cast,no_check` | implicit conversion; the checked and wrapping method families exist |
| implicit `it` and `it_index` | a name the loop introduces without spelling it; `for(xs, x => …)` names it |
| `#modify` rewriting a polymorph's type variables | an inference step a reader cannot see in the signature; bounds accept or reject and do not rewrite |
| procedure overloading, `#symmetric` | `plans/reference/FUNCTION_OVERLOADING_POLICY.md`; the operator set is fixed |
| `inline` at a call site | `RUST_ADOPTION_CANDIDATES.md` T6: a knob a model will misuse |
| `#deprecated` | no deprecation windows (single user) |
| `#through` (fallthrough) | or-patterns |
| a native x64 backend for fast debug builds | ROADMAP non-goal; compile time is lane C's, inside the C backend |
| a bytecode interpreter for compile-time execution | a performance design with no measurement behind it; reopen only if P-PERF-0 shows CTFE dominating `check` |
| pointer arithmetic outside an unsafe marker | `pragma(Pragma.AllowUnsafe)` and `unsafe(...)` |

## 4. Suggested order

| Candidate | Size | Depends on | Suggested slot |
| --- | --- | --- | --- |
| J3 the `caller_location` split | a paragraph in C6 | nothing | before C6 starts (`POST_VBD_PLAN.md` puts C6 at v0.2.86) |
| J1 the call chain | medium | C6's `SourceLocation`; P-PERF-0 for the cost gate | with Z11's sites, or NO_LIBC P2 |
| J2 arena mark and high-water mark | small | A4 | inside A4 |
| J4 flag criteria | none of its own | L8, Z13 | with Z13 |
| J6 the registry gate test | one test | C8 | inside C8 |
| J5 derive options | small to medium | a consumer | on the first JSON rename/skip or `std/cli` derive |
| J7, J8 | — | their triggers | — |

## Maintenance

As for the Zig and Rust documents: an adopted candidate moves into the plan
that lands it, with a dated pointer here; a rejected one moves to §3 with
the reason; the *(verify)* and *(from memory)* marks are re-checked before
any PR acts on them.
