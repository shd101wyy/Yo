---
applyTo: "**/*.yo, std/**"
description: "Use when making design decisions about the Yo language, writing std library code, or working with Yo types. Covers type conventions, rune, Rc/Arc/Box, str vs String, Pointer, SomeType, safe mode, parallelism, allocators, effects, async, traits, std API conventions and module layout, and compiler-source pitfalls."
---

# Yo Language Design Decisions

Spelling (what parses) lives in `yo-syntax.instructions.md`; this file holds semantics, design decisions and std conventions.

## Type naming conventions

- Lowercase for value types (non-reference-counted): `rune`, `i32`, `u32`, `bool`.
- Use `struct(...)` for value types; `newtype(...)` when the type has a single field (`FilePermission :: newtype(mode : u32)`).
- Shared ownership is `Rc(S)` (`Rc(RefCell(S))` when handles mutate the payload), atomic shared ownership `Arc(S)`. A single-owner record is a plain `struct(...)` with `self : &mut Self` mutators. The `ref(...)` / `atomic(...)` declaration forms are deleted (E0009).
- Imported source-file namespaces are structs. Do not introduce `module(...)`, `Module` or `SelfModule` syntax; use `struct(...)`, `Type` and `Self`.
- Inside a type's own definition and its `impl`s, name it `Self` (the name is not bound yet); see yo-syntax "Functions".

## Struct runtime layout

- `name :: value` and `comptime(name) : Type` fields are compile-time-only static fields/methods: in the type metadata, not in the C layout.
- An ordinary field with a compile-time-only type (`x : comptime_int`) is still a data field and makes the struct comptime-only.
- **`unit` is a true zero-sized type** (`size_of(unit) == 0`, as in Rust):
  - A `unit` struct/tuple field emits no C member (`_emit_runtime_fields` / `generate_tuple_declaration`, `src/codegen/types/generation.yo`); an enum variant's `unit` field is erased from the data union; `Array(unit, N)` has no `data` member; a unit local declares no variable; a unit field read emits no C (`generate_field_access`).
  - So `struct(a : i32, b : unit)` is 4 bytes, `Tuple(i32, unit)` 4, `enum(A(x : i32, u : unit), B)` 8, `Option(unit)` 4 (tag only).
  - An aggregate whose every field is `unit` gets one `_zst_dummy` byte and measures **1**: clang lays an empty struct out as 4 bytes on the MSVC ABI, so an empty C aggregate is never a portable ZST. An enum with no non-unit variant field emits no data union. **Never rely on an empty C aggregate having size 0.**
  - **Every consumer of a layout skips the same fields**: the `__yo_new_` constructor (`functions/constructors.yo`, `functions/declarations.yo`), the ctor call and value-struct literal (`exprs/other-fn-call.yo`, `exprs/comptime-value.yo`), the tuple literal (`exprs/tuple-fn.yo`). `sizeof` folds to a C literal, so a model/emitter disagreement in either direction is a heap bug (`issues/fixed/sizeof-of-aggregate-with-unit-field-disagrees-with-emitted-c-struct.md`).
  - The one place a `unit` occupies a byte is a by-value parameter (`get_storage_type_string`, `src/codegen/utils/index.yo`: a `uint8_t` fed `0`); that is calling convention, not layout.
  - **Containers special-case a zero element size** instead of dividing or `realloc`ing by it (`realloc(p, 0)` frees `p`): `ArrayList` of a ZST uses a one-byte anchor (`_zst_anchor`) and `SIZE_MAX` capacity.
- An `Rc` cell's header is not a payload field: a payload may name its fields `header`, `ref_count`, `gc_flags` or `type_id` (`tests/rc-cell.test.yo`).

## Unicode: `rune` not `Char`

- `char` is the C character type (8-bit); `rune` is a Unicode code point (32-bit, like Go's). File: `std/string/rune.yo`.

## Strings

- A `"..."` literal is `str` (a builtin byte view; never use `str` as a name). A template string is a `String` (UTF-8, owned); `${...}` takes any `ToString` value. Literal typing and escapes: yo-syntax "Strings".
- **`String` is a value; copies are explicit `clone()`; copy-on-write is out** (`plans/archive/STRING_VALUE_SEMANTICS.md`).
  - `String` is `newtype(_bytes : ArrayList(u8))`. `t := s` moves (a later use of `s` is E0901 naming `s.clone()`); nothing shares a buffer; `String` is `Send`/`Sync`.
  - Every mutator (`push_str`, `push_string`, `push_byte`, `push_rune`, `reserve`, `clear`, `truncate`, `insert_str`, `insert`, `remove`, `pop`) takes `self : &mut Self` and writes in place.
  - Writing through a borrowed copy (a by-value parameter, a `for`/`match` binding) is E0908: take `x : &mut String`, return the new string, or clone into a local. `for(&mut xs, s => s.push_str("!"))` and `xs(i).push_str("!")` write elements in place.
  - Bytes are copied or moved, never lent: `to_bytes()` (copy), `into_bytes()` (moves out), `from_bytes(sink(bytes))` / `from_utf8(sink(bytes))`; read in place with `len()`, `byte_at(i)`, `get_byte(i) -> Option(u8)`, `bytes()`. `String`'s `Index(usize)` is read-only (`s(i)` reads a byte; `s(i) = b` is an error naming `IndexMut`, since a byte write could break UTF-8).
  - A template string appends a `String` part by borrow (`ToString.append_to`); only a first part renders through `to_string()`.
  - Shared text is `Rc(String)`. User docs: `docs/en-US/STRINGS.md` §Writing through a copy of a `String`, `docs/en-US/STRINGS.md`.
- **String indexing is byte-based everywhere** (`plans/archive/STD_API_AUDIT_D4_PLAN.md`): `len()` is the O(1) byte count; `at`, `substring`, `s(a..b)`, `index_of`, `last_index_of`, the positional arguments of `contains`/`starts_with`/`ends_with` and the `Pattern` trait all use byte offsets, at runtime and for `comptime_str`. `substring` clamps out-of-range but panics on an offset inside a rune; `try_substring` does not panic; `floor_char_boundary`/`ceil_char_boundary` snap offsets. Rune work is `chars()` / `char_indices()`; the rune count is `s.chars().count()` (the O(n) cost stays visible).
- **`replace` replaces every occurrence** (Rust's `str::replace`); `replacen(pattern, new, count)` is the bounded form. `replace_first` / `replace_all` are deprecated aliases still exported. **`Regex.replace(haystack, rep)` (the method on a `Regex`) replaces the first match**, as in the Rust regex crate; `String.replace(re, rep)` (the `Pattern` dispatch) replaces all.
- Print with `println` / `print` from `std/fmt` (a template string or any `ToString` value), not `printf`.

## `Rc`, `Arc` and `Box`

- **`Rc(V)` / `Arc(V)`** are prelude newtypes over the cell primitives (`newtype(_cell : __yo_cell(V))`, `newtype(_cell : __yo_atomic_cell(V))`). The payload is `where(V <: Escapable)` (E0909); `Arc` also needs `V <: (Send, Sync)`.
  - Construct with `Rc.new(v, (alloc : Option(Allocator)) ?= .None)` / `Arc.new(...)` (or `Rc(T).new(v)`); the allocator goes to the cell. A direct `Rc(T)(v)` is E0405 (private field). The old `rc`/`box`/`arc` functions are deleted: a call is E0401, whose `yo fix` repair rewrites it (`_deleted_handle_ctor`, `exprs/identifer-and-operator.yo`). `rc` is an ordinary name.
  - `Rc.new`/`Arc.new` declare `-> Rc(V)`/`-> Arc(V)`, not `-> Self` (a written return type is re-evaluated per specialization, which types the capture-struct cell `dyn` builds), and bind the handle before returning it (`cell := Rc(V)(…); cell`). Open gap: `issues/2026-10-23-a-generic-constructors-specialization-keeps-its-declared-return-for-a-capture-struct-argument.md`.
  - `ref_count(x)` (`BF_REF_COUNT`) is the only count builtin (`1` for a value type, an atomic load for `Arc`, an error on a `Box`). It is not a reserved binding name: the `markdown-yo` dependency binds a local `ref_count`.
  - The compiler recognizes the shared cell by name only through `shared_cell_names_at` (`src/types/guards.yo`), never a literal.
- **`Box(V)` is the unique, uncounted cell** (Rust's `Box<T>`): `Box :: (fn(comptime(V) : ?Sized) -> comptime(Type))(newtype(_cell : *V))`, `Box.new(v, (alloc : Option(Allocator)) ?= .None)` (sized `V` only).
  - Plain std Yo: `Drop` (drops the payload through `drop_in_place`, frees by `size_of_val`/`align_of_val`; a placed cell carries the 16-byte owner prefix and bit 0 of the handle says so; a zero-sized global cell is the dangling handle `16`), `Clone` where `T <: CloneInto`, `Eq`/`Hash`/`Default` by payload, `Deref`, `Send`/`Sync` bounded on `T`, `Box.allocator(b)`.
  - Move-only; copy explicitly with `Box.clone(b)` (`b.clone()` is E0616; a non-last-use copy is E0901).
  - The compiler knows it through one guard, `unique_box_payload_type` (`src/types/guards.yo`; not in `shared_cell_names_at`): `b.*` is the payload place, a pattern looks through it (`Pattern.ThroughBox`, bindings below it borrow), the `Acyclic` walk sees through it, `Option(Box(T))` keeps the NULL niche.
- **`dyn(...)` needs a spelled owner** (decision 49): `dyn(Box.new(v))`, `dyn(Rc.new(v))`, `dyn(Arc.new(v))`, or a lent place `dyn(&v)`. A plain `dyn(v)` of a non-pointer value is E0620.
  - A cell payload whose type mentions a type variable (`dyn(Rc.new(<closure>))`, `f : Impl(Fn(...))`) is built by the prelude's compiler-internal `__yo_rc_cell` / `__yo_arc_cell` / `__yo_box_cell` function values bound to the callee node (`_prelude_cell_constructor`, `_dyn_cell_args_recognized`, `src/evaluator/values/dyn.yo`), so no name is looked up. `dyn(Rc.new(<closure>))` / `dyn(Arc.new(<closure>))` are recognized with or without `alloc`; `Rc(T).new(<closure>)` is not (a closure's type cannot be written). An `Impl(Fn(...))` parameter's type variable can dispatch `new` (`_is_open_fn_param_slot`, `values/impl.yo`). These helpers go once the open issue above is fixed.
  - The clone of a `Dyn` over a placed cell (`_emit_dyn_clone_function`) passes the source's owner (`__yo_scope_of_object`) as the fresh cell's allocator.
- **Auto-dereference (`Deref`, `plans/VALUES_BY_DEFAULT.md` §3.3).** `Box`, `Rc` and `Arc` implement `Deref` (`Target := V`): a member the wrapper lacks is looked up on the payload (`w.f` is `w.*.f`, `w.m()` is `w.*.m()`, recursively). Spelling, `Deref` owners and `DerefMut`: yo-syntax "`Rc` / `Arc` handles".
  - A name both the wrapper and its payload have is E0616 (`_reject_wrapper_payload_clash`, `calls/function.yo`; the callee arm of `evaluate_property_access`), naming `Rc.m(w)` and `w.*.m()`; `yo fix` rewrites to `Rc.m(w)`. The check is off while a generic body is specialized (`issues/the-wrapper-payload-clash-is-not-reported-inside-a-generic-body.md`). `derive(T, Clone)` spells a `Deref` field's clone `(type_of(self.f) <: Clone).clone(&self.f)`.
  - Implementation: the field hook is the label-miss arm of `evaluate_property_access` (it replaces the object argument with a `w.*` node from `make_deref_expr` and re-evaluates; in callee position only when the wrapper has no method of that name); the method hook is `_try_find_receiver_method`'s miss path. `deref_target_type` (`trait-checking.yo`) is the one predicate.
  - Outside the prelude a `Deref`/`DerefMut` impl needs an unsized `Target` (`[T]`, `str`, a `Dyn`), else E0622 (`_throw_if_deref_impl_outside_prelude`, `values/impl.yo`).

## Pointers

- `Pointer` works in compile-time and runtime contexts (`Runtime` and `Comptime` traits in `prelude.yo`).
- Comparison is plain `==`/`!=`/`<`/`<=`/`>`/`>=` (address identity). Arithmetic is `p.add(n)`, `p.sub(n)`, `p.offset_from(q)` (inside `unsafe(...)`).
- No NULL in Yo. A nullable pointer is `?*T` (two tokens, `?` + `*`) or `Option(*T)`; `Option(*T).None` is emitted as NULL.

## Unsafe operations

- `unsafe.cast(value, TargetType)` (prelude) is a reinterpret cast, an alias for the internal `__yo_as`. Use sparingly. Keep `export(__yo_as);` in the prelude: the evaluator lowers type casts (`u32(x)`) to `__yo_as` calls.
- End a value early with the prelude's `drop(x)` (moves `x` in). Code that owns a slot through a raw pointer destroys it with `drop_in_place(p)` (Rust's `ptr::drop_in_place`; takes a `*(T)`, so only pragma'd code calls it). std's `Box`, `ArrayList`, `HashMap`, `Deque` and `Channel` use it.
- `drop_in_place`'s body is the std-internal `___drop(p.*)`. `___drop` is dispatched by spelling (not a bindable value) and rejected outside a `pragma(Pragma.AllowUnsafe)` FILE; an enclosing `unsafe(...)` does not count, because a generic body is evaluated at its call site (`issues/fixed/2026-10-21-the-drop-builtin-is-callable-outside-unsafe.md`). The RC-release builtins (`__yo_decr_rc`, `__yo_decr_rc_atomic`, `__yo_dyn_drop`, `__yo_sometype_drop`, `__yo_drop_array_element`, `__yo_drop_tuple_element`) share the gate, `is_destroying_builtin_call_capable` (`src/evaluator/memory-safety.yo`); a new builtin that destroys its argument in place calls it too.

## Safe mode: how runtime failure works (`plans/backlog/SAFE_MODE.md`)

A file without `pragma(Pragma.AllowUnsafe)` gets these guarantees. When you change one, keep the evaluator, codegen, docs and `pack/context.md` in step.

- **Class-1 ban (E0611).** A safe file may not call `unwrap` / `expect` / `unwrap_err` / `expect_err` on an `Option`/`Result`: the type already carries the failure. Exempt: `*.test.yo` (and the runner's `.yo_selftest_batch_*`), `AllowUnsafe` files, `auto-generated://` code; std has no blanket exemption. Predicates `is_class1_panic_*` (`src/evaluator/memory-safety.yo`); gate sites: two in `exprs/property-access.yo`, one in `calls/function.yo`. Criterion for a new name: does the call ignore failure information the type already gave the caller? Value-level preconditions (indexing, `/`) are class 2: they trap, they are not banned. `yo public-safe-report std` lists every `Option`/`Result` method reaching `__yo_panic` as `gated`/`comptime`/`UNGATED`, and `tests/internal/memory-safety-paths.test.yo` fails on an `UNGATED` prelude one: a new trapping extraction goes into `is_class1_panic_method_name` in the same change.
- **Union member reads need the pragma.** `u.x` or `{ x } := u` reinterprets raw memory (a union does not record its active member). Construction and member writes stay legal. Predicate `is_union_member_read_capable`; gate sites: the union arm of `exprs/property-access.yo` and `exprs/destructuring-assignment.yo`.
- **Comptime.** `unwrap` is not comptime-evaluable; use `comptime_unwrap` / `comptime_unwrap_err` (legal everywhere). A `__yo_panic` reached by a LIVE compile-time execution is `compile-time panic: <msg>` (`evaluate_panic`); a body is live when every argument is known and no untaken arm of an enclosing comptime body contains the call (`FuncOrAsyncBlockCtx.ctfe_live`, `EvalContext.ctfe_untaken_arm_depth`). Do not key a comptime diagnostic on `ctx.is_executing && !ctx.is_validating_function_definition` alone: a comptime call inside a runtime body runs in a validating context.
- **Traps** (rc 134, `file:line:col` in the message, identical at every `-O`; every trap is defined behavior): fixed-`Array` and `str.bytes` index out of bounds, integer `/`/`%` by zero, `MIN / -1`, `+ - *` overflow and `-MIN` on every width, a shift count ≥ the width. Comptime rejects all of these at compile time.
- **Wrapping and saturation are explicit.** Arithmetic that wraps by design calls `wrapping_add` / `wrapping_sub` / `wrapping_mul`; a hash, PRNG, checksum or atomic helper using plain `+`/`*` traps on its first large input. Float→int casts saturate (NaN → 0); int→int narrowing truncates.
- **Escaped unwinds are never lost; observed aborts are silent.** An unwind that aborts an async task is registered, not printed. Any read of the Aborted state observes it silently: `JoinHandle.await` → `.None`, an awaiter's `io.await` (propagates; the awaiter is registered in turn), `JoinHandle.state()` / `is_finished()`, `io.state`. An unobserved one prints `unhandled effect unwind aborted an async task that was never awaited` once (when its last reference is released or the program body returns). `JoinHandle.abort()` never registers. An unwind escaping `main` prints `unhandled effect unwind escaped to top level` and aborts; a test-batch `main` clears the flag instead.

## Parallelism rules (`plans/reference/PARALLELISM_RULES.md`)

The guarantee is data-race freedom for every program that compiles without `pragma(Pragma.AllowUnsafe)` and uses std's primitives.

- **`Send` vs `Sync` (D10, decision 38 E).** `Send` = may be MOVED to another thread; `Sync` = copies may be READ from several threads. `Send` needs every component `Send` and no non-atomic cell.
  - An atomic object (`Arc`) is `Send` iff its fields are `Sync`. `ThreadPool` is a move-only value that owns its workers (TP-1), shared as `&pool` or `Arc(ThreadPool)`; dropping it is `shutdown`. The `std/sync` types are NOT atomic objects (VERDICTS-70 Q2): `Mutex(T)`, `RawMutex`, `RwLock(T)`, `Cond`, `Barrier`, `Semaphore`, `WaitGroup`, `Once`, `OnceCell(T)` and the `Atomic*` types are move-only structs over a private `Box` with explicit `Send`/`Sync` impls and `self : &Self` methods, shared as `Arc(Mutex(T))` (a copy is E0901); `Channel(T)` holds an `Arc` of its queue and implements `Clone`. `Mutex(T)` is `Sync` for `T <: Send` (explicit impl). Raw pointers are neither: a type holding one opts in with `impl(T, Send())`/`impl(T, Sync())` under the pragma (`Channel`, `Waker`); `enforce_atomic_object_send` (asks `Sync`) skips pragma'd files because their impl registers after the type.
  - `Dyn(Trait)` is `Send`/`Sync` only through an explicit bound (`_thread_marker_named_in`, `values/dyn.yo`); a `Dyn(Trait, Send)` payload need not be `Sync` (a `Box`-owned payload has one owner), but a shared payload must be atomically counted (`Arc.new(v)`, not `Rc.new(v)`). A closure literal that borrows its captures (`closure_literal_is_borrowed`) is never `Send`.
  - Every marker list (`_marker_name_of`, the step-4b re-derivation, `record_closure_capture_verdicts`, `function_value_marker`, the manual-impl pragma gate) names both markers.
  - Bounds: `Arc` and `RwLock` need `T <: (Send, Sync)` (each handle or read guard reads from its own thread; the last release may run on any thread). `Arc(T)`'s own `Send`/`Sync` impls stay explicit under that bound (an `Impl(Fn)` payload is `Sync` only by value). `Mutex`/`Channel`/`Sender`/`Receiver`/`OnceCell`/`Thread(T)` need `T <: Send`. None requires or declares `Acyclic` (an `Arc` cycle leaks, as in Rust; `plans/archive/WEAK_AND_UNCOLLECTED_RC.md`): the marker is derived and a positive impl is rejected (`_throw_if_acyclic_impl`, `values/impl.yo`; `impl(T, !Acyclic)` opts out). `Thread.spawn` / `spawn` / `spawn_on` take `Impl(FnOnce(...), Send)` with a `T <: Send` result.
  - A `Send`-but-not-`Sync` type (`impl(T, !(Sync()))`) is the canary (`tests/send-sync.test.yo`).
- **Rust's thread rule.** Data that crosses threads must itself be `Send`, derived purely structurally; there is no runtime uniqueness walk. An `Rc` graph is thread-local; `Rc.try_unwrap` takes the value out of a uniquely held handle.
- **D1, module globals.** A closure bound to a `Send`/`Sync` closure type (a spawn body, a pool task, a `Dyn(Trait, Send)` method) may not reach a non-`Sync` module-level global, directly or through anything it calls, nor a value global written anywhere (a mutable static). Check: `function_reaches_non_send_global` (`src/evaluator/effects/mutation-summary.yo`). Use `thread_local(name)` for per-thread state, an `Atomic*` or a `std/sync` lock for shared state. A pragma'd std file is the audited base (its globals are under a lock: `std/log.yo`, `std/encoding/html.yo`).
- **`mut(name)` globals (decision 47).** A module-level or `thread_local` runtime binding is Rust's `static` unless declared `mut(name)` (`static mut`). Writing an unmarked one is E0917 (`global_require_mut`, `src/evaluator/utils.yo`); lending a `mut(...)` one, or a place under it, to a call is E0916 (`_check_call_global_lends` over `_call_lends`, `src/evaluator/calls/function.yo`; E0910 shares `_call_lends`). A door global (`RefCell`, the `std/sync` doors) needs no marker for writes through it. Applies everywhere, `std/` and `src/` included. A borrowing future is E0909 only for a place rooted in a `mut(G)` or `thread_local(mut(x))` binding (`_reject_global_lend_to_future`).
- **Written collection globals are `RefCell` globals** (`plans/VALUES_BY_DEFAULT.md` B5). In `src/`, a module-level `ArrayList`/`HashMap`/`HashSet` written after its initializer is declared `(g_x : RefCell(T)) = RefCell(T).new(T.new());` and used only through `g_x.with(m => m.get(k))` / `g_x.with_mut(m => m.insert(k, v))`. A global nothing writes (`g_empty_value_cell`, `g_empty_path_collection`, `g_scope_names`, `BuiltinYoInlineFunctions`, `PrimitiveTypeTags`, `_c_reserved_words`) stays a plain binding; a `mut(G)` collection global only reassigned and read by value is decision 47's case.
  - Find the written ones with `YO_AUDIT_GLOBAL_LEND=1 yo check ./src` (a `recv-mut` lend or a `[global-write]` line), not a one-line grep (`yo fmt` wraps long declarations).
  - Runtime globals cannot be exported, so every use is in the declaring file.
  - Keep each closure body to the one collection operation: an argument that reaches the same global (a recursive memo fill, `G.len()` inside `G.drain(...)`) is evaluated before the access, or the nested access panics (`RefCell.with_mut: the value is already borrowed`; nested `with` reads are fine). A `return`/`break` inside the closure leaves the closure, not the function.
- **`mut(name)` locals (decision 47 step 2).** Every binding below module level (local, pattern, destructuring, `::`/`comptime(...)`) is immutable unless declared `mut(name)`; parameters take no marker (rebind). The marker is stripped at desugar (`desugar_if_calls`, `_strip_mut_binders`, `src/expr.yo`) and recorded by the declared name's token (`register_mut_binding`, `is_mut_binding`), so env copies and generic re-evaluation keep it; a malformed marker (`mut(x.f)`) is left for `reject_malformed_mut_marker`.
  - No pass writes the tree: a type-directed evaluator rewrite (auto-dereference, the `dyn(v)` box) records the rewritten node (`note_rewritten_node`); readers go through `ast_rewritten_node` / `ast_rewritten_view`.
  - Writes go through `binding_require_mut` / `place_require_mut` (`src/evaluator/utils.yo`): E0917. Exempt: `src/`, `scripts/`, the root `build.yo`, fetched dependencies (`/store/sha256/`) and `auto-generated://` modules (`is_global_mut_rule_exempt`, `src/evaluator/memory-safety.yo`); `std/` is not. Census: `YO_AUDIT_MUT_BINDINGS`. `yo fix <path>` repairs one write per pass.
- **D3, no writes through an atomic object.** No `=`, index store, or `&mut` argument whose callee may write (per-parameter mutation mask), rooted in an `Arc` (a `std/sync` value's state is private, behind its `Box`). A read-only `&mut self` method (`ToString`, `Hash`) through an `Arc` stays legal.
- **D8, second-class captures.** A closure may not capture a `&mut` parameter or a control-bound value. A rejection that fires inside a definition-time trial must be flagged with `flag_flow_violation` before it throws, or the trial swallows it; the trial's caller re-raises it with `reraise_flow_violation`, which flags it again, so it survives an enclosing trial (a handler inside an `io.async` body).
- **D4 + D9, function values.** A function value holds `Send` iff its captures are `Send` AND its code reaches no non-`Send` global; `Acyclic` is the captures alone. The VALUE decides wherever it is known: `function_value_marker` (`src/evaluator/utils/closure.yo`, via `call_function_value_marker`) runs at every where-clause path, both `Impl` argument paths, `Impl` results and captures. A bare `fn(...)` type with no value (a struct field, a `Channel(fn() -> unit)` payload) is NOT `Send`, so a std type that crosses threads holds `Impl(Fn(...), Send)`, never a bare `fn` field. A new site judging a function-typed value for a marker passes the value as the witness.
- **D6, runtime externs.** Calling a `__yo_*` runtime extern (any `extern` other than `"c"`) by name or through a module value needs the pragma. Expose a runtime entry point as a Yo wrapper function in a pragma'd module, never a bare alias (`get_thread_id :: __yo_get_thread_id;` made every caller call the extern).
- **D5 / D7, runtime.** `std/sync` primitives record their owner and trap on misuse. A thread that touches another thread's event loop registers in the loop's `visitors` count while the loop is provably alive, and loop teardown waits for it (`__yo_async_loop_quiesce`). The loop's live-waker count drops only in the owner's drain.

## Explicit allocators: placement, not lifetime (`plans/archive/EXPLICIT_ALLOCATORS.md`)

- An `Allocator` (`std/allocator.yo`) is `{ctx, vtable}`: a two-word `Send` value, never reference counted. Every block it hands out carries a 16-byte owner prefix (`{ctx, vtable}`) before the returned pointer, and every release routes through it, so a block returns to its allocator on any thread. Codegen writes the same layout (`__yo_alloc_prefix_t`) for a placed RC object and marks it with the top bit of `ref_count` (`__YO_RC_TAG`): mask every count TEST with `__YO_RC_COUNT`, never a write.
- **Global by default, placement by argument** (`plans/reference/ALLOCATOR_PLACEMENT.md`). A creation without an allocator argument is global. `Box.new`/`Rc.new`/`Arc.new` and the containers' `new`/`with_capacity` take `(alloc : Option(Allocator)) ?= .None`; `clone_in(a)` on `ArrayList`/`HashMap`/`String`/`StringBuilder` places a copy. There is no allocation scope (`with_allocator`/`current_allocator` are deleted).
  - Global: the containers' default constructors, `dyn`'s cell, interpolated strings, closure environments, `io.async` task state machines (`__yo_rc_alloc`). A cell constructor takes its allocator as its first C parameter (`__yo_rc_alloc_in`).
  - A user function that passes placement on declares `(alloc : Option(Allocator)) ?= .None`; the raw-view parameter gate treats the prelude's `Allocator` as an opaque handle, so a safe file may.
  - std is compiled into the compiler by the seed, so a std change that calls a new runtime hook is seed-gated.
- Containers record their allocator in the top bit of a word they already have (ArrayList/Deque capacity, HashMap's tombstone count), never in a new field. Read such a word through its masked accessor (`_cap()`, `tombstones()`).
- std ships no arena; the replacements are `plans/backlog/ZIG_STYLE_ALLOCATORS.md`'s `FixedBufferAllocator` (A1) and `ArenaAllocator` (A3). A test that needs "some explicit allocator" uses `Allocator.global()`, or a counting allocator defined in the test file (`tests/explicit-allocators.test.yo`).
- User guide: `docs/en-US/EXPLICIT_ALLOCATORS.md` (and zh-CN). Keep it, `MEMORY_SAFETY.md`'s section and `pack/context.md` in step when the surface changes.

## SomeType

- `SomeType` implements the `Runtime` trait by default.
- Never write functions to resolve `SomeType`, and **never substitute a SomeType within another type**: struct/enum/union are nominal, so substitution breaks type identity. Re-evaluate the type expression in an env where the type parameter is bound to the concrete type.
- **Every `Impl(Trait)` annotation wrapper is a SomeT with the RESERVED name `"Impl"`** (`src/evaluator/builtins/impl-constraint.yo`). Logic that matches or binds SomeTs BY NAME (param↔return substitution, env markers, where-clause bookkeeping) must exclude that name (and nameless dyn wrappers): two wrappers in one signature are unrelated. Missing it types a call as one of its arguments' types (`issues/fixed/generic-impl-async-method-closure-param-return-type-collapse.md`). Do NOT fix it by renaming the SomeT (breaks every `== "Impl"` check), skipping its env binding (std stops checking) or keying env bindings per id (`io.async`/`io.await` share wrapper bindings by name).
- **A function literal (`=>`/`->`) cannot take an `Impl(Fn(...))` PARAMETER** (`_is_unresolved_impl_fn_type`, `src/evaluator/values/anonymous-function.yo`): a literal has one lowered body, so it cannot monomorphize per call site. Take `Dyn(Fn(...))` or write a named `fn`.

## Platform-specific code

Use `platform` and `Platform` from `std/process`:

```yo
{ platform, Platform } :: import("std/process");

AF_INET6 :: cond(
  (platform == Platform.Macos) => i32(30),
  true => i32(10)
);
```

Targets: Linux, macOS and Windows.

## A bare integer literal converts at argument positions, NOT as a receiver

A literal converts to any runtime integer type at argument positions (`xs.push(1)`, `f(0)`), but as the LEFT operand of a binary operator with a runtime operand of a differing type (`(0..n)`, `(3 == n)`, `(1 + n)` for `n : usize`) it can be rejected with a phantom "runtime argument to compile-time parameter" diagnostic (open: `issues/an-integer-literal-on-the-left-of-a-runtime-operand-is-rejected.md`; do not rely on either direction). Put the runtime operand on the left (`(n == 3)`, `(n + 1)`, `usize(0)..n`) and cast both ends of an all-literal runtime range (`i32(0)..i32(5)`).

## Verification: a green `yo verify` is not "everything proved"

`assumed` (contracts declared, body never walked) and `outside-subset` (nothing promised, the walk could not enter) PASS a plain `yo verify` by design (gradual adoption, `std/collections` dogfooding), so the exit code alone says nothing about coverage.

- Gate a specification directory with `yo verify <path> --strict` (= `--deny assumed,outside-subset,unproven`), which fails those outcomes in every mode, including `verify+`. Adding `assumed()` to silence a finding is then visible.
- Read the summary line, not just the exit code: it prints every outcome count and how many `ok` results were VACUOUS (discharged no obligation). `--format json` carries the same under `summary`. `plans/backlog/SELF_VERIFICATION.md` ratchets on the non-vacuous count.
- **Laws state claims outside the code:** `name :: law(fn(x : T, requires(p), ensures(q)) -> unit);` (a written-out fn type with clauses, no body). A law is proved from the callee's CONTRACT alone, evaluates to `unit` and is erased in codegen. A non-`unit` return, no `ensures`, `assumed()`, `decreases(...)` or a named alias in place of the fn type are compile errors; `unproven` has no assert fallback for a law (so `--strict` decides); a law is never `outside-subset`; its callee may be imported. Full contract and workflow: `docs/en-US/FORMAL_VERIFICATION.md` §Laws.

## API stability: the language may still break, `std` may not

Yo the LANGUAGE is still evolving — language-level breaking changes are acceptable when the design calls for them. The STANDARD LIBRARY closed its breaking window with the S2 sweep (`plans/archive/STD_API_AUDIT.md` §1, §5–§6): every `std` module is **stable** unless its module doc carries a `## Stability` section, and stable modules change **additively only**:

- Additive = new modules, new exported functions/types/constants, new trait impls, new enum variants only where the enum is documented as non-exhaustive, new optional builder methods, wider accepted inputs, bug fixes that make behaviour match the documentation. Renames, signature changes, removed exports, changed error variants, changed defaults and changed wire/serialization formats are NOT additive — they need a documented deprecation (`# Deprecated` doc section on the old name, kept working) and land only with a new module or as a parallel API.
- A NEW module enters as `unstable` for one release: its inner doc ends with
  ```
  //! ## Stability
  //! unstable — new in vX.Y.Z; the API may still change until the next release.
  ```
  `yo doc` renders the marker (HTML badge, `"stability"` in JSON, a note in Markdown); the audit's §7 table records when a module was frozen. Drop the section to freeze it.
- Dead surface is not "stable": an export with no consumer and no test is deleted BEFORE it is frozen (the §6 rule), never marked stable by default. Freezing an export no test exercises is how a broken API becomes permanent (C34).

## Compile-time only functions must use `comptime` return types

A function that only runs at compile time (build-system functions, macro-like utilities) wraps its return type in `comptime(...)`; otherwise the evaluator treats it as a runtime function. Parameters are `comptime(name) : T`; returns are `-> comptime(Step)`, `-> comptime(unit)`, `-> comptime(str)`.

```yo
// WRONG — unit return without comptime means runtime:
register_module :: (fn(comptime(config) : ModuleConfig) -> unit)({
  __yo_build_module(config.name);
});

// CORRECT — comptime(unit) signals compile-time only:
register_module :: (fn(comptime(config) : ModuleConfig) -> comptime(unit))({
  __yo_build_module(config.name);
});
```

## Algebraic effects

The core rule (`return(expr)` in a handler resumes, `unwind(expr)` discards the continuation) is in AGENTS.md. Design: `docs/en-US/ALGEBRAIC_EFFECTS.md`.

- Effect handlers are **explicit parameters**: a function that uses an effect names it in its signature (`safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)`), and callers pass the handler by name (`safe_divide(i32(10), i32(0), raise)`).
- Install a handler with a local binding: `(raise : Raise) = ((msg) -> { unwind(i32(-1)); });` (a lambda on the RHS of `=` needs outer parens).
- A handler that may `unwind` has type `ctl(args) -> R`; one that always resumes can be `fn(args) -> R`. Subtyping is one-way: `fn(T) -> R <: ctl(T) -> R`. `unwind` is valid only inside a `ctl` body and exits the install frame (the function that bound the handler).
- For effect-bundle polymorphism, quantify over a struct: `generic(E : Type.Struct)`, and pass `E` as the Future's single effect argument.
- Handlers use evidence passing (function-pointer parameters).
- **Handler functions are standalone, not closures**: compiled as standalone C functions, they cannot reference variables of the enclosing scope. Pass state as explicit arguments.
- Pointers/references to control-bound types (any type transitively containing a `ctl(...) -> R`) are rejected: handlers live on the stack of the install frame.

## Futures, `io.async` and `io.await`

- `Future(T)` or `Future(T, E)`: `E` is ONE type, typically a struct bundling every effect the async body needs (`Ctx :: struct(io : Io, raise : Raise)`). A function using `io : Io` that runs an async body names the bundle in its return type: `Impl(Future(Result(T, E), Ctx))`, and `Impl(Future(T, Io))` for an `(io : Io) =>` body. A bundled future is never viewed as `Future(T)` (E0605: an await through the view injects nothing); `Future(T)` is a raw `IoFuture`'s type, and it flows into any bundle. `sleep`, `yield` and the async `Mutex`/channel methods return `Impl(Future(T, Io))`: a struct-bundled task awaits them with its `Io`, `ctx.io.await(sleep(d, ctx.io), ctx.io)`.
- `io.async` takes one closure typed `Impl(FnOnce(e : E) -> T)` and returns `Impl(Future(T, E))` (`std/prelude.yo`). The closure takes exactly ONE parameter, the effects struct: `(io : Io) =>` for an `Io`-only future, `(e : IoExn) =>` when it also throws, with every operation through `e.io` / `e.exn`. The body must NOT capture `io` or `exn` from the enclosing scope (control-bound values cannot be captured).
- `io.await(future, e)` takes the future's effects type: `Future(T, Io)` → `io.await(future, io)`; `Future(T, IoExn)` → `e.io.await(future, e)`; low-level IO futures (`IO_*`, e.g. `IO_dir.mkdir`) → `io.await(future, io)` only.
- Return `io.async(...)` directly as the last expression, or through a local that a later statement returns (or that is the body tail); both infer the closure's bare-variant tail from the function's result type (`issues/fixed/io-async-variant-inference-passes-check-but-fails-compile.md`):

```yo
// CORRECT — return io.async directly:
my_fn :: (fn(io : Io) -> Impl(Future(Result(i32, String), Io)))(
  io.async((io : Io) => {
    zero := i32(0);
    .Ok(i32(42) + zero)
  })
);

// CORRECT — through an intermediate local that is returned (or is the tail):
my_fn :: (fn(io : Io) -> Impl(Future(Result(i32, String), Io)))({
  task := io.async((io : Io) => {
    zero := i32(0);
    .Ok(i32(42) + zero)
  });
  return(task);
});

// WRONG — two parameters; WRONG — the body captures the enclosing `io`:
// io.async((io, exn) => { ... });
// io.async((e : IoExn) => { io.await(future, io); });

// CORRECT — all effects through e:
io.async((e : IoExn) => {
  e.io.await(create_dir_all(path, e.io), e);
  e.exn.throw(dyn(Box.new(`error`)));
});
```

## Async iteration: the `Stream` trait (`std/async/stream.yo`)

The async analogue of `Iterator` (`plans/reference/ASYNC_ITERATION_STREAM.md`):

```yo
Stream :: trait(
  Item : Type,
  next : (fn(self : &mut Self, io : Io) -> Impl(Future(Option(Self.Item), Io)))
);
```

- **The future's bundle is `Io`, never `IoExn`: a stream does not throw.** A fallible stream puts the failure IN the item (`Item = Result(T, E)`, e.g. `TcpListener.incoming`'s `Result(TcpStream, NetError)`), so one bad item does not end the sequence and no consumer installs a handler. An API that throws (`Reader.read`, `BufReader.read_line`) cannot become a stream until it can return its failure (`plans/backlog/ASYNC_LINES_NEEDS_A_NONTHROWING_READ.md`).
- `next`'s future borrows the source, so it is awaited where it is made.
- **`.None` is terminal and stays terminal.** Every combinator preserves it.
- **The associated type is named `Item`.** The assoc-type registry is keyed by (type id, label) with no trait discrimination, so a type implementing both `Stream` and `Iterator` must give them the SAME `Item` (`FromIterator` uses `Elem` to dodge this).
- The loop is written out: `mut(s) := stream;` then `while(true, …)` around `n := io.await(s.next(io), io);` and `match(n, .Some(x) => body, .None => { break; })`, so `break`/`continue`/`return` work. There is deliberately no named loop form: **a suspension point is an `io.await` written in the `io.async` body; an `io.await` inside a function the task calls blocks instead of suspending.** A name that hides the await hides the suspension point. For the same reason an `Iterator.next` that awaits, driven by a plain `for` inside a task, compiles silently and serialises or deadlocks.

## JoinHandle(T): spawned task handle

`JoinHandle(T)` is the prelude struct `io.spawn` returns; it OWNS one reference to the spawned task's future.

```yo
handle := io.spawn(task, ctx); // → JoinHandle(T), ctx is the task's effect bundle
result := handle.await(io); // → Option(T), blocking: main / plain fns only
result := io.await(handle.join(io), io); // → Option(T), suspending: the form inside a task (std/async)
handle.state();
handle.is_finished();
handle.abort();
```

- **A future is move-only** (`plans/VALUES_BY_DEFAULT.md` §3.13 A1): `io.await(f, e)` and `io.spawn(f, e)` consume `f`; `io.state(&f)` borrows it. A second await, or an await after a spawn, is E0901; a result several tasks need is joined once and shared (`Rc(T)`, a channel). An `io.async` body that awaits a CAPTURED future moves it in with a capture list (`io.async({ f }(io : Io) => io.await(f, io))`; an implicit capture is E0913), and a function that awaits or captures a future parameter takes it `sink(f) : Impl(Future(T, E))`.
- `io.spawn(task, e)` copies the bundle `e` into the cold future, runs the task INLINE up to its first suspension point (spawn is not itself one), and returns the handle.
- **A future may borrow, and is then second-class** (§3.13 A2). An `io.async` body with a borrow in its capture list (`{ &x }`, `{ &mut x }`) makes a future that is awaited where it is made (`io.await(bump(&mut c, io), io)`).
  - It may be returned only when every borrow is rooted at the returning function's own `&`/`&mut` parameters. Binding it to a local, storing or spawning it is E0909.
  - Also E0909: lending it a place through an `Rc`/`Arc` deref (pass the handle, `h : &Rc(S)`, and read `h.*.f` inside), or a place rooted in a `mut(G)` / `thread_local(mut(x))` binding (another task can reassign it during the await; lend a local copy). Unmarked globals and `::` constants are fine. The `Rc` rule is checked at the call that makes the future, so arms and block tails do not hide it, and it covers index places (`&mut xs(i)`).
  - A `&T` parameter reaches C by value, so the future keeps its own copy of a lent `&` parameter (`__yo_lent_<label>`) and borrows the parameter whole: `{ &p.f }` on a `&` parameter is an error in a capture list, and a returned future reaching a `&T` parameter only through a captured closure is E0909.
  - A call through a function value is assumed to borrow every place it lends; a match-arm binding and `_ := ...` are bindings. With a borrowing future, `io.await`'s bundle must be a place (`io`, `self.io`; E0910), and a later argument of the call that makes it may not move, assign or `&mut`-lend (also as a `&mut self` receiver) a place an earlier argument lends (E0910). `dyn(v)` is E0909 when a vtable method of `v` returns a borrowing future.
- `handle.await(io)` returns `.Some(result)` on completion, `.None` when the task was aborted (an `unwind`, or `handle.abort()`). **A `JoinHandle` is move-only (§3.13 A3): awaiting or `join` CONSUMES it** (a second is E0901); `state()`, `is_finished()`, `abort()` and `as_ptr()` borrow it.
  - `handle.await(io)` is a BLOCKING poll loop in every context; inside an `io.async` body it nests the event loop (`YO_ASYNC_STRICT=1` panics there). Inside a task use `io.await(handle.join(io), io)`; a body that joins a captured handle moves it in (`io.async({ h }(io : Io) => io.await(h.join(io), io))`).
  - The `std/async` combinators (`join_all`, `race`, `race_first`, `any`, `any_first`, `timeout`) are futures of the same kind and take their handles BY VALUE: `io.await(join_all(handles, io), io)` in `main` and in a task alike. `join_all`/`race_first`/`any_first` drain the list and `timeout` consumes its handle; `race`/`any` hand the list back (`(w, rest) := io.await(race(handles, io), io)`) so the losers can still be aborted. Walk a handle list by borrowing in place (`hs(i).abort()`), own one with `pop()`/`remove(i)`; `get(i)` copies and is E0901.
- Dropping the handle without awaiting DETACHES the task (it keeps running and frees itself), which makes a fire-and-forget `io.spawn(task, e);` correct. Abort-on-drop is deliberately NOT the semantics.
- `JoinHandle(T)` and `Io` are `!Send` and `!Sync` (the task lives on the spawner's loop thread).
- Definition: `JoinHandle :: (fn(comptime(T) : Type) -> comptime(Type))(struct(__future : *T));` the `*T` field makes `T` appear in the fields, so the type synthesizer can extract `T` during generic impl matching.

## Trait impls are visible only through the caller's imports

Method resolution (`get_visible_type_trait_methods_by_name`, `src/evaluator/values/type-trait-methods.yo`; the generic-impl fallback in `values/impl.yo`) sees an `impl` only if its registering module is in the current module's transitive import closure, or is the prelude. A module that calls integer/`str` `to_string` therefore imports `std/fmt`. The closure comes from import edges recorded from each module's SOURCE at load time (`_record_static_import_edges`, `src/module-manager.yo`), so it does not depend on evaluation order. `YO_VISIBILITY_REPORT=1` enumerates would-be misses instead of rejecting them, to find missing imports before they fail a batch.

## Traits with associated types

Traits use `trait(...)` with associated types as labeled `Type` fields:

```yo
Iterator :: trait(
  Item : Type,
  next : (fn(self : &mut Self) -> Option(Self.Item))
);

// impl — provide concrete values for all fields
impl(
  Counter,
  Iterator(
    Item : i32,
    next : (fn(self : &mut Self) -> Option(Self.Item))(
      cond(
        (self._current >= self._max) => .None,
        true => {
          val := self._current;
          self._current = (self._current + i32(1));
          .Some(val)
        }
      )
    )
  )
);

// Where clause — use `:=` to constrain associated types (not `:`)
IntoIterator :: trait(
  Item : Type,
  IntoIter : Type,
  into_iter : (fn(self : Self) -> Self.IntoIter),
  where(Self.IntoIter <: Iterator(Item := Self.Item))
);
```

- **`:` in an impl** creates a TraitValue (provides all fields); **`:=` in a where clause** creates a specialized TraitType (constrains associated types only).
- Wrap `fn` types in parentheses inside trait fields: `next : (fn(...) -> T)`.

## Trait method disambiguation with where-clause constraints

When a type implements several traits with a same-named method, `where(T <: T1)` makes `self.m()` dispatch to `T1`'s, and `(T <: T2).m(self)` selects `T2`'s explicitly (syntax and examples: yo-syntax "Trait method dispatch"). Implementation:

- Where-clause constraints are applied BEFORE argument binding, so the SomeType has its trait constraints during method lookup.
- Runtime parameters with a constrained SomeType stay typed as the SomeType (not the concrete argument type) to preserve trait filtering.
- `get_receiver_methods_by_name_from_env` (`src/env.yo`) filters impl'd traits by the SomeType's where-clause constraint ids.
- Concrete FunctionValues are resolved from trait impls for static dispatch in codegen (no vtable).

## No overloading; comptime variants are named

- Yo does **not** support function overloading (`plans/reference/FUNCTION_OVERLOADING_POLICY.md`): an exported `Call` holding a tuple of two or more candidates is rejected everywhere except `std/prelude.yo`, whose runtime/comptime operator modules (`Call :: (neg, comptime_neg)`) are the only sanctioned overload sets (`is_overload_set_capable_file`, `src/evaluator/memory-safety.yo`; gated at the export choke point in `src/evaluator/values/anonymous-module.yo`). A single-function `Call` (a callable module) is allowed.
- Comptime variants get a `comptime_` prefix (`comptime_unwrap` beside `unwrap`). For comptime methods on generic types (`Option(T)`, `Result(T, E)`) use a separate `impl` with `where(Self <: Comptime)`.
- **Duplicate inherent method names are rejected**: a second same-name INHERENT impl for a type errors with `Method "X" is already defined for this type` (`src/evaluator/values/impl.yo`, keyed on the defining site so loader re-evaluation and per-instantiation re-registration stay legal). Trait-provided methods may share a name. This keeps `Type.method_name` extraction unambiguous; it works on enums too (`Option(i32).unwrap` is a callable function value).

## Operator traits use associated type Output

All operator traits (Add, Sub, Mul, Div, Rem, BitAnd, BitOr, BitXor, Shl, Shr, Exponentiation, Neg, BitNot) declare `Output` as an **associated type**, not a parameter, as `Index` does. Binary traits take `Rhs` as a type parameter. Operands are BY VALUE, as in Rust's `Add::add(self, rhs)`; only `Eq`, `Ord`, `ComptimeEq` and `ComptimeOrd` borrow (`lhs : &Self, rhs : &Rhs`). An impl writes exactly the trait's modes and provides `Output` explicitly. Unary traits (Neg, BitNot) are parameterless; comptime variants add `where(Self <: Comptime, Self.Output <: Comptime)`.

```yo
Add :: (fn(comptime(Rhs) : Type) -> comptime(Trait))(
  trait(
    Output : Type,
    (+) : (fn(lhs : Self, rhs : Rhs) -> Self.Output)
  )
);

impl(
  i32,
  Add(i32)(
    Output : i32,
    (+) : ((lhs, rhs) -> __yo_op_add(lhs, rhs))
  )
);

ComptimeAdd :: (fn(comptime(Rhs) : Type, where(Rhs <: Comptime)) -> comptime(Trait))(
  trait(
    Output : Type,
    (+) : (fn(comptime(lhs) : Self, comptime(rhs) : Rhs) -> comptime(Self.Output)),
    where(Self <: Comptime, Self.Output <: Comptime)
  )
);
```

## Higher-Kinded Types (HKT)

Yo supports HKT with **comptime function types as kinds**: type constructors like `Option` and `Result` are first-class comptime functions. Partial application (`Result(_, i32)` is a `Type → Type`) works on any comptime function: yo-syntax "Partial application with `_`".

```yo
// F is a type constructor (kind: Type → Type)
identity :: (fn(generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type), x : F(A)) -> F(A))(x);

// An HKT trait
Functor :: (fn(comptime(F) : (fn(comptime(T) : Type) -> comptime(Type))) -> comptime(Type))(
  trait(
    map : (fn(generic(A : Type, B : Type), self : F(A), f : Impl(Fn(a : A) -> B)) -> F(B))
  )
);

// Constrain a type-constructor application with where(F(A) <: Trait(F))
do_map :: (
  fn(
    generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type, B : Type),
    container : F(A),
    f : Impl(Fn(a : A) -> B),
    where(F(A) <: Functor(F))
  ) -> F(B)
)(
  container.map(generic(B), f)
);
```

`TypeApplication` (`F(A)`) is compile-time only: fully resolved during specialization, it must never reach codegen.

## Option and Result combinators

`Option(T)` and `Result(T, E)` provide Rust-style combinators; callbacks are `Impl(Fn(...))`, the generic parameter is inferred, and `a => expr` lambdas infer their parameter types.

- **Option**: `map`, `and_then`, `filter`, `or_else`, `flatten`, `map_or`, `map_or_else`, `ok_or`, `ok_or_else`, `and`, `or`, `unwrap_or_else`
- **Result**: `map`, `map_err`, `and_then`, `or_else`, `and`, `or`, `ok`, `err`, `map_or`, `map_or_else`, `unwrap_or_else`

```yo
(x : Option(i32)) = .Some(i32(5));
result := x.map(a => (a * i32(2))); // .Some(i32(10))
chained := x.and_then(
  a =>
    cond((a > i32(0)) => Option(i32).Some(a * i32(2)), true => Option(i32).None)
);
```

## Generalized Algebraic Data Types (GADTs)

An enum variant may declare the instantiation it produces with `-> recur(...)` (syntax: yo-syntax "GADT variants"; design: `plans/reference/GADTS.md`, `docs/en-US/ADVANCED_TYPES.md`).

- Without the annotation a variant produces the unconstrained type parameters (regular enum behavior); annotated and unannotated variants mix.
- Match refines the type parameter per arm: in `match(v, .IntVal(i) => i, .BoolVal(b) => b)` each arm sees `T` as the variant's declared type.
- Exhaustiveness excludes variants the scrutinee's type cannot hold (`BoolVal` when matching `Value(i32)`).
- The runtime representation is identical to a regular enum; all GADT logic is erased at compile time.

## std error handling: three blessed styles, no fourth

Decided in `plans/archive/STD_API_AUDIT.md` D1. When you add or change a fallible std API, pick from exactly these three; if none fits, that is a design discussion, not a licence to invent a fourth.

| Situation | Style |
| --- | --- |
| I/O, and anything on the `io` path (fs, net, http, process) | **effects** — `exn : Exception` / `IoExn` |
| pure fallible transforms: parsing, decoding, conversion | **`Result(T, TypedError)`** |
| lookups where absence is not an error | **`Option(T)`** |

Rules that follow from it:

- **`Result(_, String)` is banned.** An error type is a real enum implementing `Error()`: a string error cannot be matched on, downcast or wrapped. The `Error()` marker is enforced: `dyn(Box.new(x))` checks that `x`'s type implements every required trait of the target `Dyn`, so `exn.throw(dyn(Box.new(e)))` on an error enum without `impl(E, Error())` is a compile error at the `dyn(...)` token. `AnyError` is `Box(Dyn(Error, Clone))` (`std/error.yo`), so the type must be `Clone` too (`derive(E, Clone)`; the `Clone` bound is an interim, not a decision). `throw` takes the error BY VALUE: a handler owns the error it catches, keeps it by moving it (`unwind(.Some(e))`, `xs.push(e)`) and lends it with `&e` to a read-only helper.
- **Spell an error enum with `derive(T, Error)`, not two hand-written impls.** One message per variant, in DECLARATION ORDER, emits `ToString` and `Error` together; each message is checked against its variant, so a renamed/added/removed/reordered variant is a compile error.

  ```yo
  derive(
    JsonError,
    Error(
      .UnexpectedChar => `unexpected character at position ${pos}`,
      .UnexpectedEnd => `unexpected end of input`,
      .Other => `JSON error: ${msg}`
    )
  );
  ```

  The message is ordinary Yo spliced into the arm that binds the payload, so `${pos}` is the variant's own field, not a positional `{0}`. Write the two impls by hand only when the render is not one message per variant (a struct error, a body that needs a local). `Error` carries `where(Self <: ToString)`.
- **Never drop the payload on failure.** `Channel.send` returning `Result(unit, unit)` discarded the value the caller still owned; return it.
- A constructor that cannot fail should not be fallible: no `Result` "for symmetry".
- Absence and failure are different: do not model a missing key as an error, or an I/O failure as `None`.

## std naming conventions

Decided in `plans/archive/STD_API_AUDIT.md` D2: one name per concept across the tree. A new module that invents a synonym is a review defect.

| Concept | Blessed name | Do not use |
| --- | --- | --- |
| element count | `len()`, plus `is_empty()` on EVERY container | a public `size` field |
| map insert | `insert(k, v) -> Option(V)` (returns the old value) | `set` |
| set insert | `insert(v) -> bool` | `add` |
| sequence append | `push` / `push_front` / `push_back` | — |
| membership | `contains` (sequence/set), `contains_key` (map) | — |
| value iterator | `into_iter()` | — |
| pointer iterator | `iter()` | `iter_ptr` |
| accessors | a bare noun | a `get_` prefix |
| byte codecs | `encode` / `decode` | `to_ascii` / `to_unicode` |
| text formats | `parse` / `stringify` | `decode_html`-style verb-first names |
| conversion | `from_` / `to_` / `into_`, with Rust's discipline (`into_` consumes) | two spellings of one conversion (`to_cstr` vs `to_c_str`) |
| comptime twins | `Comptime` prefix on the trait, `comptime_` prefix on the method | an infix `_comptime_` |

- **Divergences from Rust's std that stay** (`plans/backlog/STD_RUST_ALIGNMENT.md` §4; the pack prints the same list). Do not "fix" one toward Rust; a new module follows the Yo column.

| Rust | Yo | Reason |
| --- | --- | --- |
| `Vec<T>`, `vec![..]` | `ArrayList(T)`, `ArrayList(T).from([..])` | maintainer's decision: in mathematics a vector has a fixed size and this type grows; no std name says `Vec` |
| `VecDeque`, `BinaryHeap` | `Deque`, `PriorityQueue` | the abstract type's name, not one implementation's (`OrderedMap`, `StringBuilder`, `WaitGroup`, `Semaphore` have no Rust std counterpart) |
| `char` | `rune` | `char` is C's 8-bit type and FFI needs it |
| `Path` + `PathBuf` | one owned `Path` | no unsized path view |
| `PartialEq`/`Eq`, `PartialOrd`/`Ord` | `Eq(T)`, `Ord(T)` | floats carry a total `cmp`; no split |
| `Not` | `LogicalNot`/`BitNot` | two operators where Rust has one; `!` is `LogicalNot`, on `bool` only (`x == 0` tests a number), `~` is `BitNot` |
| `collect::<T>()`, `parse::<T>()`, `into()` | `collect(T)`, `parse(T)`, `into(T)` | the type is an argument: Yo does not infer from the result type |
| `lock()`, `borrow()`/`borrow_mut()`, `Cell` | `with_lock(v => ..)`, `with_read`/`with_write`, `with`/`with_mut` | closure-scoped access; a guard cannot have `g.*` outside the prelude (E0622); no poisoning |
| `io::Result<T>`, blocking calls, `thread::spawn`, `JoinHandle<T>` | `exn : Exception`, `io : Io`, `-> Impl(Future(T, IoExn))`, `Thread(T).spawn((io : Io) => ..)`, `join() -> T` | effects and the `Io` interface |
| `sync::Weak`, `atomic::Ordering` | `ArcWeak`, `MemoryOrder` | one flat prelude namespace: `Weak` and `Ordering` are taken |
| `Duration` over `u64`/`u128` | `Duration` over `i64`; `as_millis() -> i64` | no 128-bit integers; a negative span is representable |
| serde's `from_str`/`to_string` | `json`/`toml` `parse`/`stringify` | one verb pair for every text format |
| `unwrap`/`expect` everywhere | E0611 outside tests and unsafe-capable files | safe mode |

  The compiler keeps the unresolved-name half of this table in `rust_std_name_hint` (`src/diagnostics.yo`: E0401 prints the Yo name and its import) and the float-method import help in `float_method_import_hint` (E0610 on `f32`/`f64`); a divergence added here that a model will write by its Rust name gets a row in that function.
- A rename sweep also rewrites the `test("<Type>.<method> …")` name strings (and comments) that spell the renamed method: `--test-name-pattern` matches them, so a stale name hides the test (`issues/fixed/collection-test-names-still-use-pre-rename-method-spellings.md`).
- **`sys/` is plumbing, `std/*` is the product.** Every user-relevant syscall gets a typed wrapper, and an underscore-private name never appears in an `export(...)` list. For struct fields and impl methods the `_` prefix is the visibility rule the compiler enforces (E0405, `plans/reference/MEMBER_VISIBILITY.md`): private to the declaring module and its same-directory siblings. A `_` member another directory needs is an API gap to close with a public method.
- **Traits are the API.** An inherent method that duplicates a trait method becomes a trait impl, so generic code can dispatch on it. Types that should compose get `Eq` / `Ord` / `Hash` / `Clone` / `ToString`.
- **Hashing is Rust-shaped** (`plans/reference/HASHER_REDESIGN.md`). `Hash.hash(self : &Self, hasher : &mut H)` FEEDS bytes; a `Hasher` (`std/hash.yo`: `SipHasher13` = `DefaultHasher`, `Fnv1aHasher`) turns them into the `u64`. Never write a `-> u64` hash method or fold hashes with `* 31`; an impl calls `hasher.write_*` per field (or `derive(T, Hash)`), variable-length data writes a terminator/length, and `hash_one(&v)` is the one-value helper. Maps use FIXED default keys so emitted C and printed maps are reproducible (the fixpoint compares C byte for byte); `HashMap.with_keys` is the per-instance opt-in.

## UTF-8 lives in exactly one module

`std/encoding/utf8.yo` is the only place in the tree that knows how UTF-8 is laid out. Do not add another copy of the bit twiddling.

| you need | call |
| --- | --- |
| decode a rune at a byte offset, strictly | `decode(bytes, i) -> Result(Decoded, Utf8Error)` |
| decode without ever failing (a scanner over untrusted bytes) | `decode_lossy(bytes, i) -> Decoded` — U+FFFD, width ≥ 1 |
| decode from a buffer that is not an `ArrayList(u8)` | `decode_parts(b0, b1, b2, b3, available, index)` — fetch the bytes yourself, no allocation |
| encode a `rune` | `encode_into(r, out)` / `encode(r)` |
| encode a raw `u32` from a decoder (`\uXXXX`, a UTF-16 unit, `towlower`) | `encode_lossy_into(code, out)` — substitutes U+FFFD, so you cannot emit CESU-8 |
| advance a rune-walking loop | `step_len(b)` — never `cond((b < 0x80) => 1, (b < 0xE0) => 2, …)` |
| test a rune boundary | `is_boundary(b)` / `is_continuation(b)` |
| check a whole buffer or a sub-range | `validate(bytes)` / `validate_range(bytes, from, to)` |

- **It stays below `std/error` and `std/fmt`**: it imports only `std/string/rune` and `std/collections/array-list`, because `std/string/string.yo` consumes it and `std/error`/`std/fmt` import `std/string`. So `Utf8Error` has inherent `message()`/`index()` instead of `ToString`/`Error()` impls (as `AllocError` has none); a module that wants a throwable UTF-8 error wraps it (`StringError.InvalidUtf8(cause : Utf8Error)`).
- **`String.from_bytes` does not validate**: it is the unchecked constructor. Use `String.from_utf8` for bytes of unknown provenance (a file, a socket, a subprocess, a decoded payload); `from_bytes` only when the bytes demonstrably are UTF-8. `String.from_cstr` does not validate either, deliberately.

## Standard library module organization (`std/`)

- **A module on `std/assert`'s own import path cannot import it.** `std/assert` imports `std/string`, so
  `std/string/string.yo` (and anything else `std/assert` reaches) panics with the `__yo_panic` builtin.
- **`dir/index.yo`** only when a directory holds a single public module whose name would duplicate the directory's (`dir/dir.yo`): users write `import("std/url")`, not `import("std/url/url")`. Examples: `std/url`, `std/regex`.
- **A flat `.yo` file** for a module with one file and no planned submodules (`std/env.yo`, `std/log.yo`, `std/glob.yo`), not a directory holding only an `index.yo`. Use a directory once the module has companion files (helpers, platform splits, sub-APIs).
- **No catch-all `index.yo`** for a directory of distinct submodules; users import each one (`import("std/net/tcp")`, `import("std/collections/hash-map")`, `import("std/fs/file")`). This category: `std/net`, `std/fs`, `std/sync`, `std/time`, `std/crypto`, `std/encoding`, `std/collections`, `std/cli`, `std/testing`.
- **A primary file plus companions** gets an `index.yo` that re-exports them all:

```yo
// std/http/index.yo: http.yo (types) + client.yo + server.yo
_http :: import("./http.yo");
_client :: import("./client.yo");
_server :: import("./server.yo");
export(...(_http), ...(_client), ...(_server));

// Users write:
{ HttpRequest, fetch } :: import("std/http");
```

## Index trait (unified indexing)

All container indexing goes through traits with an associated `Output`:

- `Index(Idx)`: `index(self : &Self, idx : Idx) -> &Self.Output`. `IndexMut(Idx)` is the write half (`index_mut(self : &mut Self, idx : Idx) -> &mut Self.Output`), used by `c(i) = v`, a `&mut` lend or receiver, and `addr_of`; a type with `Index` and no `IndexMut` has read-only elements (`String`).
- `ComptimeIndex(Idx)`: `index(comptime(self) : &mut Self, comptime(idx) : Idx) -> comptime(*Self.Output)`. The comptime binding is erased at runtime, but mutations through it propagate to the caller through the evaluator's binding-update path.
- `Array`'s impls call the compiler builtin `__yo_array_index` (emitted inline as `&((&recv)->data[idx])`) so they do not recurse into `Index`; the comptime impls call `__yo_comptime_array_index`, `__yo_comptime_list_index[_range][_inclusive]` and `__yo_comptime_string_index[_range][_inclusive]`. Other containers (ArrayList, HashMap, BTreeMap, Deque, String) implement `Index` with ordinary methods.
- **`comptime_str` indexing is by BYTE offset**, like the runtime: `"Hello"(0)` is `"H"` (the rune starting at byte 0, as a 1-rune `comptime_str`; a runtime `String` reads a `u8` with `byte_at(i)`, a deliberate result-type split, `docs/en-US/STRINGS.md`), `"Hello"(0..3)` and `"Hello"(0..=2)` are `"Hel"`. An offset inside a rune, or out of range, is a compile error.
- **`Self.Output` with several Index impls** (`Index(usize)` and `Index(Range(usize))`): the associated-type field expressions are extracted from the impl body (`Output : T`), the re-evaluation loop in `find_methods_from_generic_impls` (`src/evaluator/values/impl.yo`) evaluates them with concrete substitutions, and `src/evaluator/exprs/property-access.yo` checks the env for `Output` before calling `find_associated_type_from_generic_impls` (which would be ambiguous).
- **Comptime element pointers**: comptime array indexing returns `EvalValue.PtrVal(target_value, target_index, aggregate_ty)` (`src/value.yo`; `target_value(0)` is the backing `ArrayVal`, `target_index` the element), which enables compile-time `arr(0) = val` (`src/evaluator/exprs/assignment.yo`) and `addr_of(arr(0))` (`src/evaluator/builtins/ptr-fns.yo`).

## Compiler-source (`src/`) pitfalls

Patterns that bite when editing the compiler's own Yo source; `yo check ./src` catches them.

### Environment/EvalContext parameters: never use `addr_of()`

`Environment` is an `Rc(RefCell(EnvironmentData))` handle (`src/env.yo`), so every holder sees the same frames; `EvalContext` is a value lent as `ctx : &EvalContext` / `ctx : &mut EvalContext`. `addr_of(env)` makes a `*(Environment)`, which matches neither.

```yo
// WRONG — addr_of() creates a pointer to the handle, a type mismatch:
_some_fn(addr_of(ee), addr_of(ge));

// CORRECT — lend the handle:
_some_fn(&ee, &ge);
```

### Taking over another env: `env_adopt`, never reassignment or `.*`

Parameters are immutable, and `env_ptr.* = info.env` is a C pointer operation that fails in `check`. To make an env parameter (`env`, `expected_env`, `env_mut`) take over another, call `env_adopt` (`src/env.yo`): it shares the frame list (`Rc`, copy-on-write on the next push/pop) and the other fields, and runs the `YO_DEBUG_FROZEN` guard. Do not write the fields one by one.

```yo
// WRONG — cannot reassign a parameter:
env_mut = result.env;

// CORRECT:
env_adopt(&env_mut, &result.env);
```

### Token positions: `character` is a rune offset, `byte_offset` indexes the source

`Token.character` counts runes (the lexer's `input.chars()` counter, served to the LSP as a `character`
position); `Token.input` is byte-indexed. Slicing `input` with `character` corrupts any source holding a
multibyte character (`issues/fixed/yo-self-formatter-corrupts-files-with-non-ascii.md`, where `yo fmt`
rewrote non-ASCII files at rc 0). Index with `Token.byte_offset` (`src/token.yo`).

### A swallowing handler's `unwind` skips the restore after the guarded call

`unwind(...)` exits the function that installed the handler, so a save/restore around the guarded call
in that same function never restores on the failure path:

```yo ignore
saved := ctx.flag;
ctx.flag = true;
r := evaluate_something(..., exn); // the handler unwinds from here
ctx.flag = saved; // skipped when the handler unwinds
```

Install the handler in a helper and save/restore in its caller, which the `unwind` lands in. Adding a
swallowing handler to existing code is therefore not behaviour-preserving: a flag that leaked harmlessly
while the error aborted the compile now stays set for the rest of it (a leaked
`is_analyzing_ctfe_capability` once hollowed `tests/fn.test.yo` while every single-file repro was clean).

### Exception threading: always add `exn` to calls

The evaluator threads `Exception` explicitly as the last parameter of every function that may error (Yo has no ambient `throw`). A new fallible helper takes `exn : Exception` last and passes it to every callee:

```yo
// Raise an error:
exn.throw(dyn(Box.new(format_error_message(...))));

// Call a fallible helper — exn goes last:
evaluate_type_annotation(expr, env, ctx, exn);
```

### Function-type re-evaluation during impl specialization

Generic-impl specialization (`src/evaluator/values/impl.yo`; older docs call the pass `reEvaluateFunctionType`) re-evaluates a function type's parameter/return type expressions with concrete substitutions. It must preserve:

- The **returned env** has the same frame count as the specialization env. Using the function type's own captured env (the definition scope) adds frames from impl field-list evaluation and breaks the "Cannot initialize a variable that is defined outside the function body" frame-level check in `src/evaluator/exprs/assignment.yo`.
- The **re-evaluation env** may differ from the returned env: it only evaluates type expressions and may include extra scope (HKT variables like `F`).
- Variables from the captured env missing from the specialization env (`F` from an HKT trait scope) are merged into the returned env, because parameters keep their ORIGINAL source type expressions (`F(A)` from a trait definition) and every re-evaluation needs the same variables.

| Purpose | Use |
| --- | --- |
| Returned function type's captured env | the specialization env (correct frame count) + merged missing vars |
| Re-evaluating the stored type expressions | an env built from the function type's captured env (has all scope vars) |
| Frame-level checks in `assignment.yo` | compared against the captured env's frame count |
