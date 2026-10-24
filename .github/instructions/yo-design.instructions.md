---
applyTo: "**/*.yo, std/**"
description: "Use when making design decisions about the Yo language, writing std library code, or working with Yo types. Covers type conventions, rune, Rc, str vs String, Pointer, SomeType, and platform-specific code."
---

# Yo Language Design Decisions

## Type naming conventions

- Lowercase for value types (non-reference-counted): `rune`, `i32`, `u32`, `bool`
- Use `struct(...)` for value types
- Use `ref(struct(...))` / `ref(enum(...))` for reference-counted (reference-semantics) types; `atomic(ref(struct(...)))` / `atomic(ref(enum(...)))` for atomic RC
- Use `newtype(...)` instead of `struct(...)` when the type has only a single field (e.g., `FilePermission :: newtype(mode : u32)`)
- Imported source-file namespaces are represented as structs. Do not introduce
  `module(...)`, `Module`, or `SelfModule` syntax; use `struct(...)`, `Type`,
  and normal `Self`.

## Struct runtime layout

- Fields written with `name :: value` or `comptime(name) : Type` are compile-time-only static fields/methods. They are available through the type metadata but are not emitted into the C runtime layout.
- Ordinary fields with compile-time-only types (for example `x : comptime_int`) are still data fields. They make the containing struct comptime-only unless another rule changes the type; do not treat them like `::` fields.
- **`unit` is a TRUE zero-sized type — `size_of(unit)` is 0, as in Rust, and a `unit` field costs nothing.** The emitter lays out NOTHING for it: a `unit` struct/tuple field emits no C member (`_emit_runtime_fields` / `generate_tuple_declaration`, `src/codegen/types/generation.yo`), an enum variant field is erased from the data union, `Array(unit, N)` has no `data` member, a unit local declares no variable, and a read of a unit field emits no C (`generate_field_access`). C struct members are accessed by NAME, so erasing one shifts nothing. So `struct(a : i32, b : unit)` is **4** bytes, `struct(b : unit)` is **1** (the dummy), `Tuple(i32, unit)` is **4**, `enum(A(x : i32, u : unit), B)` is 8 (tag + `i32`) and `Option(unit)` is tag-only at 4. An aggregate whose every field is `unit` gets a single one-byte `_zst_dummy` member and measures **1** — NOT 0 and NOT an empty struct: clang lays an empty struct out as 0 bytes on GNU targets but **4 bytes on the MSVC ABI** (`*-windows-msvc`, measured with `-Xclang -fdump-record-layouts`), so an empty struct is not a portable ZST and a model saying 0 under-allocated every container of such an aggregate on Windows. An enum with no non-unit variant field emits NO data union and no `data` member (an empty union is 4 bytes on MSVC too — `issues/fixed/empty-enum-data-union-is-4-bytes-on-msvc.md`). **Never rely on an empty C aggregate having size 0.** **Every consumer of a layout must skip the same fields** — the `__yo_new_` constructor's parameters and stores (`functions/constructors.yo`, `functions/declarations.yo`), the ctor call and the value-struct compound literal (`exprs/other_fn_call.yo`, `exprs/comptime_value.yo`), the tuple literal (`exprs/tuple_fn.yo`) — because `sizeof` folds to a C literal that sizes the allocations C-typed pointer arithmetic strides through, and a model/emitter disagreement in EITHER direction is a heap bug (`issues/fixed/sizeof-of-aggregate-with-unit-field-disagrees-with-emitted-c-struct.md` was the under-allocating direction). **The one place a `unit` still occupies a byte is a BY-VALUE PARAMETER** (`get_storage_type_string`, `src/codegen/utils/index.yo` — C cannot declare a `void` parameter, so it is a `uint8_t` fed `0`); that is calling convention, not layout, and `sizeof` never observes it. **Containers must special-case a zero element size** rather than divide or `realloc` by it: `ArrayList` of a ZST uses one one-byte anchor block and `SIZE_MAX` capacity (`_zst_anchor`), because `realloc(p, 0)` frees `p` on glibc and the Windows CRT. History: this arm went 0 → 1 → 0 (`issues/fixed/unit-should-be-a-true-zero-sized-type-like-rust.md`).
- **`header` is RESERVED as a runtime field name in a reference struct.** A `ref(struct(...))` emits `{ __yo_ref_header_t header; <user fields...> }`, so a user field of that name would be a second member with the same name — and every access would silently resolve to the reference-count header instead. The evaluator rejects it at declaration time with a source location (`src/evaluator/types/struct.yo`), so `yo check` catches it rather than the backend emitting C that will not compile.
  - The reservation is narrow, on purpose: it does not apply to VALUE structs (they inject nothing), it does not apply to `::` comptime fields (erased from the layout), and it does not cover the header's OWN members — `ref_count`, `gc_flags`, `type_id`, `dispose_fn`, `borrow_count`, `gc_mark` are nested INSIDE `__yo_ref_header_t` and so remain usable as field names.
  - Field-name MANGLING (renaming the user field instead of reserving the name) is the nicer fix and is deliberately deferred: it would have to rename a C member consistently across struct declaration, constructor parameters and body, struct-literal emission, field access, `_ptr_field_access`, match destructuring, `open()`, the traversal functions, dup/drop/dispose, and the `box->${field}` sites in `src/codegen/functions/dyn.yo` — and one missed site reproduces the bug or, worse, reads the wrong member. See `issues/fixed/ref-struct-field-named-header-collides-with-rc-header.md`.

## `Self` in type definitions

Always use `Self` to refer to the type being defined inside `struct(...)`, `ref(struct(...))`, `ref(enum(...))`, and `enum(...)` bodies. The type name is not yet bound during its own definition, so using it causes a "Variable not found" error:

```yo
// CORRECT — Self for recursive references:
TypeValue :: enum(
  IntType(bits : u8),
  PointerType(pointee : Rc(Self)),
  ArrayType(element : Rc(Self), length : usize)
);

// WRONG — TypeValue not available inside its own enum:
TypeValue :: enum(
  IntType(bits : u8),
  PointerType(pointee : Rc(TypeValue)),
  ArrayType(element : Rc(TypeValue), length : usize)
);
```

This applies equally to `impl` method signatures (use `Self` for parameter and return types).

`Self` also works inside **generic type constructor functions** — it refers to the current type instantiation (e.g., `Tree(T)` inside `Tree`):

```yo
// CORRECT — Self refers to Tree(T):
Tree :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    Leaf(value : T),
    Node(left : Self, right : Self)
  )
);

// WRONG — Tree is not available inside its own function body:
Tree :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    Leaf(value : T),
    Node(left : Tree(T), right : Tree(T))
  )
);
```

Use `recur(args)` only when calling the type constructor with **different** type arguments than the current instantiation (e.g., `recur(i32)` inside `Tree(T)` to get `Tree(i32)`).

## Unicode: `rune` not `Char`

- `char` is the C character type (8-bit)
- `rune` represents Unicode code points (32-bit, like Go's rune)
- File: `std/string/rune.yo`

## Strings

- Double quote string returns `str` type (contains `[u8]` byte slice)
- Template string returns `String` type (UTF-8 text; `clone()` makes an independent copy). Its syntax is the same as JavaScript template strings. The `${...}` interpolation is also supported for types that implement `ToString` trait.
- `str` is a builtin type — don't use it as a variable or type name.
- **`String` copies by `clone()`; copy-on-write is OUT** (`plans/STRING_VALUE_SEMANTICS.md` §0, S3a): every mutator (`push_str`, `push_string`, `push_byte`, `push_rune`, `reserve`, `clear`, `truncate`, `insert_str`, `insert`, `remove`, `pop`) takes `self : &mut Self` and writes in place; `clone()` copies the bytes (O(n)) and is independent, empty or not. A plain `t := s` still copies the handle — a non-empty buffer is shared, an empty one is not (`issues/a-write-through-a-string-copy-is-lost-when-the-string-was-empty.md`, open) — until VALUES_BY_DEFAULT V2b makes `t := s` a move or an error naming `s.clone()`. Writing through a borrowed copy — a by-value parameter, a `for`/`match` binding — is E0908: take `x : &mut String`, return the new string, or write a local clone (`t := x.clone();`); `for(&mut xs, s => s.push_str("!"))` and `xs(i).push_str("!")` write elements in place. The bytes are copied or moved, never lent: `to_bytes()` (an independent copy), `into_bytes()` (`sink(self)`, moves the buffer out, no copy when unique), `from_bytes(sink(bytes))` / `from_utf8(sink(bytes))`; read in place with `len()`, `byte_at(i)`, `get_byte(i) -> Option(u8)`, `bytes()`. `as_bytes` is gone, and `String`'s `Index(usize)` is read-only (V2b Generation B): runtime `s(i)` reads the byte like `byte_at(i)`, and `s(i) = b` is an error naming `IndexMut` (a writable byte place would reach every string sharing the buffer and could break UTF-8). For shared text use `StringBuilder` (a shared mutable `ref` builder). User docs: `docs/en-US/DESIGN.md` §Writing through a copy of a `String`, `docs/en-US/STRINGS.md`.
- **String indexing is BYTE-based, everywhere** (D4, `plans/archive/STD_API_AUDIT_D4_PLAN.md`, 2026-08-26): `String.len()` is the byte count at O(1), and `at` / `substring` / `s(a..b)` / `index_of` / `last_index_of` / the positional arguments of `contains` / `starts_with` / `ends_with` / the `Pattern` trait all take and return byte offsets — the same unit as `str.len()` and `StringBuilder.len()`, which were always bytes. `substring` clamps out-of-range but PANICS on an offset inside a rune; `try_substring` is the non-panicking form, `floor_char_boundary` / `ceil_char_boundary` snap arbitrary offsets. Rune work goes through `chars()` / `char_indices()` composed with iterator methods — the rune count is `s.chars().count()` (the iterator spelling keeps the O(n) cost visible; `len()` is O(1) everywhere in std). Comptime strings share the byte basis (D4 PR 7). Full contract: `docs/en-US/STRINGS.md` / `docs/zh-CN/STRINGS.md`.
- **Use template strings for constant `String` values**: Instead of `String.from("hello")`, write `` `hello` ``. Template strings without interpolation produce the same result but are more concise. This applies anywhere a `String` value is needed — return values, comparisons, arguments, etc.
- **`replace` replaces EVERY occurrence** (D10, `plans/archive/STD_API_STABILIZATION.md` §2, 2026-09-07): `String.replace` is Rust's `str::replace`. `replacen(pattern, new, count)` is the bounded form, and `replace_first` (= `replacen(..., usize(1))`) is the pre-D10 meaning, kept deprecated for one release; `replace_all` stays one release as a deprecated synonym of `replace`. **`Regex.replace(haystack, rep)` — the method ON a `Regex` — still replaces the FIRST match**, because that is the Rust regex crate's shape (`Regex::replace` vs `Regex::replace_all`); it is `String.replace(re, rep)` (the `Pattern` dispatch) that replaces all. Before the flip, four compiler call sites already assumed replace-all and were silently wrong — see `issues/fixed/string-replace-first-only-broke-compiler-callers.md`.
- Use `println` or `print` function from `std/fmt` to print instead of `printf`. You can pass template string or any value whose type implements `ToString` trait to both `println` and `print`.

## Rc and rc

Implemented in `prelude.yo`:

```yo
Rc :: (fn(comptime(V) : Type) -> comptime(Type))(
  ref(
    struct(
      (*) : V
    )
  )
);
rc :: (fn(generic(V : Type), sink(value) : V, (alloc : Option(Allocator)) ?= .None) -> Rc(V))(
  ...
);
```

The old shared spelling `Box(V)` / `box(v)` was deleted (V1 step 1 Generation B part 2).
**`Box(V)` is now the unique, uncounted cell** (V1 step 2, Rust's `Box<T>`):
`Box :: (fn(comptime(V) : Type) -> comptime(Type))(newtype(_cell : *V))` in the prelude,
`box(v, (alloc : Option(Allocator)) ?= .None)`. It is plain std Yo: a `Drop` (drop
the payload, free the cell through its 16-byte owner prefix: `{ctx, vtable}`, a `.None`
vtable = the global allocator), `Clone` where `T <: Clone` (placed where the source lives),
`Eq`/`Hash`/`Default` by payload, `Deref`, `Send`/`Sync` bounded on `T`, and
`Box.allocator(b)`. So it is move-only, explicit-copy when `T` is `Clone`: a non-last-use
copy is E0901 and the copy is `Box.clone(b)` (`b.clone()` is E0616). The compiler knows it
through ONE guard, `unique_box_payload_type` (`src/types/guards.yo`: the stamped
name `Box(` + the newtype shape; it is NOT on `shared_cell_names_at`): `b.*` is the safe
payload place (`(*b)` in C), a pattern looks through it (`Pattern.ThroughBox`, bindings
below it borrow), the cycle collector's walk traces its payload in place
(`__yo_traverse_box_<C>`), the cycle predicates see through it, `Option(Box(T))` keeps
the NULL niche, and `ref_count(b)` is an error. `src/` cannot use it until
`SEED_VERSION` carries this (the v0.2.59 seed rejects `b.*` on it, E0406).

`rc(v, (alloc : Option(Allocator)) ?= .None)` and `arc(v, (alloc : Option(Allocator)) ?= .None)`
take the same parameter. The `.Some(a)` arm sets the thread's allocation scope to `a` around
the `Rc(V)(v)` / `Arc(V)(v)` constructor (which allocates from the current scope) and restores
it, through the prelude's `__yo_scope_set` extern: no codegen, and the default path is
unchanged. That swap is the stopgap until V5's `__yo_cell`/`__yo_atomic_cell` take the
allocator themselves (VALUES_BY_DEFAULT §3.2). Both bind that `match` (`cell := match(…); cell`)
instead of ending in it: a tail `match` is typed by the declared `Rc(V)`/`Arc(V)`, and for the
`rc`/`arc` call that `dyn(...)` synthesizes around a closure capturing a generic function's
`Impl(Fn)` parameter that `V` is unbound, a second C type for the result
(`issues/fixed/2026-10-22-a-dyn-closure-in-a-generic-fn-boxes-through-a-cell-typed-by-the-unbound-return.md`;
the evaluator gap is open as `issues/2026-10-23-a-generic-constructors-specialization-keeps-its-declared-return-for-a-capture-struct-argument.md`).
Unlike `box`'s
explicit path, it runs `a`'s callbacks with `a` current (as `with_allocator` does), so an
allocator whose callbacks allocate through the scope recurses until the stack overflows
(`issues/questions/2026-10-21-should-allocator-callbacks-run-outside-the-allocation-scope.md`).

Single-payload reference-semantics types can use the payload field syntax `(*) : T` and are
accessed with `value.*`. Treat this as a value payload accessor for reference-semantics values,
not automatically as a pointer dereference; pointer dereference still applies
when the receiver itself has pointer type.

**Auto-dereference (`Deref`, plans/VALUES_BY_DEFAULT.md §3.3, V1).** `Box`, `Rc` and `Arc` implement the prelude marker `Deref :: trait(Target : Type)` (`Target := V`). On a `Deref` type, a member the wrapper lacks is looked up on the payload: `w.f` is `w.*.f`, `w.m()` is `w.*.m()`, recursively through nested wrappers. A name the wrapper AND its payload both have is E0616 (decision 32 Gen B: `_reject_wrapper_payload_clash` in calls/function.yo for methods, the callee arm of `evaluate_property_access` for a wrapper method against a payload field), naming `Rc.m(w)` and `w.*.m()`; its `yo fix` repair is `Rc.m(w)`, the old meaning. The check is off while a generic function or impl is specialized (`x.clone()` under `T <: Clone` with `T := Rc(i32)` is the bound's method), so a generic body that WRITES `w : Rc(T)` is not checked yet (`issues/the-wrapper-payload-clash-is-not-reported-inside-a-generic-body.md`). `derive(T, Clone)` spells a `Deref` field's clone `(type_of(self.f) <: Clone).clone(&self.f)`. Implementation: the field hook is the label-miss arm of `evaluate_property_access` (it REPLACES the object argument in place with a `w.*` node from `make_deref_expr` and re-evaluates, so codegen and the root-of-place walks see the explicit chain; in callee position — `w.items(i)`, `w.f(x)` — only when the wrapper has no METHOD of that name); the method hook is `_try_find_receiver_method`'s miss path (retries with receiver `w.*`, and on a hit rewrites the callee's receiver argument in place). `deref_target_type` (`trait_checking.yo`) is the one predicate. Only the prelude may `impl(..., Deref(...))` (`_throw_if_deref_impl_outside_prelude`, impl.yo). **`std/` and `src/` keep writing `.*`** until `SEED_VERSION` carries auto-deref (Generation B).

`ref_count(x)` reads the reference count of the cell `x` holds (`1` for a value type,
an atomic load for `Arc`/`atomic(ref(...))`); it is the only count builtin
(`BF_REF_COUNT`). `rc` is an ordinary prelude function, the cell constructor
(`rc(v)` returns an `Rc(T)`). **`Rc(T)` is the canonical shared cell**
(VALUES_BY_DEFAULT §6 V1 step 1, Generation B part 1 renamed every site to it); the
legacy `Box(T)` keeps the same definition and impls until part 2 deletes it.
The compiler recognises the shared cell BY NAME in a few places (the instance-name
stamp in `comptime_fn.yo`, `is_box_type`/`is_boxed_type`, `dyn(<ctor>(<closure>))`);
every such check reads the one list `shared_cell_names_at` (`src/types/guards.yo`),
never a literal `"Box"`. `dyn(v)` on a non-object still synthesizes the canonical
`rc(v)` (`shared_cell_canonical_names`). As a prelude name it cannot be redefined: a module-level or local
binding named `rc` is a shadowing error, while a parameter or a match-pattern binding
named `rc` shadows it in its scope. `ref_count` is not in
`is_reserved_builtin_binding_name`: the `markdown_yo` dependency binds a local
`ref_count` counter, so reserving it breaks the build.

## Pointers

- `Pointer` works in both compile-time and runtime contexts (`Runtime` and `Comptime` traits in `prelude.yo`).
- Pointer comparison: plain `==`/`!=`/`<`/`<=`/`>`/`>=` (Eq/Ord impls on `*(T)`, address identity). Pointer arithmetic: the methods `p.add(n)`, `p.sub(n)`, `p.offset_from(q)` (require `unsafe(...)`).
- No NULL in Yo. Nullable pointer: `?*T` — the bare prefix chain, canonical since the 2026-09-02 fmt sweep — or the explicit `Option(*T)` (there is no single `?*` token; the 2026-08-21 closed operator set made `?` + `*` two tokens). `Option(*T).None` is optimized as NULL in C codegen.

## Unsafe operations

The `unsafe` module in `prelude.yo` provides one low-level escape hatch:

- `unsafe.cast(value, TargetType)` — reinterpret cast (alias for the internal `__yo_as` builtin).

To end a value before its scope does, call the prelude function `drop(x)` (it moves `x` in). Code that must run a destructor on a slot it owns through a raw pointer calls the prelude's `drop_in_place(element_ptr)` (Rust's `ptr::drop_in_place`, maintainer decision 2026-10-21): it takes a `*(T)`, so only pragma'd code can call it. Its body is the std-internal `___drop` builtin on the place, `___drop(p.*)`. `Box`'s `Drop` uses it; `ArrayList`, `HashMap`, `Deque` and `Channel` still call `___drop(ptr.*)` inline until `SEED_VERSION` carries the codegen fix that keeps an unwind alive across a destructor's calls (the seed-built compiler runs those destructors; `plans/backlog/SEED_VERSION_AUTOMATION.md`). `___drop` is dispatched by the callee's spelling, so it is not a bindable value, and it is rejected outside an unsafe-capable FILE (a `pragma(Pragma.AllowUnsafe)` file; the drops the compiler synthesizes are `auto-generated://` and pass). Unlike a raw-pointer dereference, an enclosing `unsafe(...)` does not count: a generic body is evaluated at its call site, so `unsafe(f(...))` in a pragma'd file would otherwise admit a `___drop` written in a safe file's generic `f`: `___drop(h.xs)` on a field in safe code was a heap use-after-free (`issues/fixed/2026-10-21-the-drop-builtin-is-callable-outside-unsafe.md`). The RC-release builtins that destroy a place the same way (`__yo_decr_rc`, `__yo_decr_rc_atomic`, `__yo_dyn_drop`, `__yo_sometype_drop`, `__yo_drop_array_element`, `__yo_drop_tuple_element`) share the gate, `is_destroying_builtin_call_capable` in `src/evaluator/memory_safety.yo` (`issues/fixed/2026-10-22-the-rc-release-builtins-are-callable-outside-unsafe.md`); a new builtin that destroys its argument in place calls it too. `unsafe.drop` was a macro forwarding to it and is deleted (`plans/backlog/MACRO_AND_ISO_REMOVAL.md` B4).

```yo
// Cast between types (use sparingly)
result := unsafe.cast(ptr, *u8);
```

**Note:** `__yo_as` is still exported from prelude as a top-level symbol because the evaluator internally transforms type casts (e.g., `u32(x)`) into `__yo_as` calls. Do not remove `export __yo_as;`.

## Safe mode: how runtime failure works (`plans/SAFE_MODE.md`)

A file without `pragma(Pragma.AllowUnsafe)` gets the following guarantees. When you change one, keep the evaluator, codegen, docs, and cheatsheets in step.

- **Class-1 ban (D7, E0611).** A safe file may not call `unwrap` / `expect` / `unwrap_err` / `expect_err` on an `Option`/`Result`, because the type already carries the failure and the call would discard it. Exempt: `*.test.yo` files (and the runner's `.yo_selftest_batch_*` files), `AllowUnsafe` files, and `auto-generated://` code. **std has no blanket exemption:** its safe files follow the same rule. The predicates are `is_class1_panic_*` in `src/evaluator/memory_safety.yo`. Three gate sites use them: the two in `exprs/property_access.yo` and the dispatch gate in `calls/function.yo`. The criterion for adding a name: *does the call ignore failure information the type already gave the caller?* Value-level preconditions (indexing, `/`) are class 2. They trap at runtime and are not banned. The name list is checked against the source: `yo public-safe-report std` lists every `Option`/`Result` method that reaches `__yo_panic` as `gated`, `comptime`, or `UNGATED`, and `tests/internal/memory_safety_paths.test.yo` fails on an `UNGATED` one in the prelude. A new trapping extraction must be added to `is_class1_panic_method_name` in the same change (`Result.expect_err` shipped ungated until this check existed).
- **Union member reads need `pragma(Pragma.AllowUnsafe)`.** Reading `u.x` or destructuring `{ x } := u` is raw-memory reinterpretation, because a union does not record which member was written. Reading another member's bytes as a `bool`, enum or reference is C undefined behavior. Construction and member writes (`u.x = v`, evaluated with `is_lhs_of_assignment`) stay legal. The predicate is `is_union_member_read_capable` in `src/evaluator/memory_safety.yo`; its two gate sites are the union arm of `exprs/property_access.yo` and `exprs/destructuring_assignment.yo` (issues/fixed/safe-code-can-read-an-inactive-union-member.md).
- **Comptime.** `unwrap` is not comptime-evaluable. The comptime spellings are `comptime_unwrap` / `comptime_unwrap_err`, and they are legal everywhere. A `__yo_panic` reached by a LIVE compile-time execution is a compile error, `compile-time panic: <msg>` (`evaluate_panic`). A body is live when every argument is known and no untaken arm of an enclosing comptime body contains the call (`FuncOrAsyncBlockCtx.ctfe_live` / `EvalContext.ctfe_untaken_arm_depth`). Do not key a new comptime diagnostic on `ctx.is_executing && !ctx.is_validating_function_definition` alone: a comptime call inside a runtime function body runs in a validating context, and a gate built that way misses it (measured on the first version of this check).
- **Traps (tier 3, rc 134, `file:line:col` in the message, identical at every `-O`).** Every trap is defined behavior. The trapping operations: fixed-`Array` and `str.bytes` indexing out of bounds, integer `/` or `%` by zero, `MIN / -1`, `+ - *` overflow and `-MIN` on every width (signed and unsigned), and a shift count ≥ the width. Comptime rejects all of these at compile time already; runtime now matches.
- **Wrapping and saturation are explicit.** Arithmetic that wraps by design must call `wrapping_add` / `wrapping_sub` / `wrapping_mul`. A new hash, PRNG, checksum, or atomic helper that uses plain `+`/`*` is a trap waiting for its first large input: #841 found two such sites only through CI. Float→int casts saturate (NaN → 0). Int→int narrowing truncates.
- **Escaped unwinds are never lost, and observed aborts are silent.** An unwind that aborts an async task is *registered*, not printed. Any read of the Aborted state observes it silently: `JoinHandle.await` → `.None`, an awaiter's `io.await` (the escape propagates and the awaiter is registered in turn), `JoinHandle.state()` / `is_finished()`, or `io.state`. A task nobody observed prints `unhandled effect unwind aborted an async task that was never awaited`, once, either when its last reference is released or when the program body returns. `JoinHandle.abort()` cancellation never registers. An unwind escaping `main` prints `unhandled effect unwind escaped to top level` and aborts. A test-batch `main` clears the flag instead, as the test-runner boundary (`issues/fixed/an-awaited-task-abort-is-reported-as-unhandled.md`).

## Parallelism rules (`plans/reference/PARALLELISM_RULES.md`)

The guarantee is data-race freedom for every program that compiles without `pragma(Pragma.AllowUnsafe)` and uses std's primitives. The rules a std or compiler author runs into:

- **D10, `Send` vs `Sync` (VALUES_BY_DEFAULT §3.8, decision 38 E).** `Send` = may be MOVED to another thread; `Sync` = copies may be READ from several threads. Today's derivation is `Sync`; `Send` additionally needs every component `Send` and no non-atomic cell. An atomic object is `Send` iff its fields are `Sync`; `Mutex(T)` is `Sync` for `T <: Send` (explicit impl). Raw pointers are neither: a type holding one opts in with `impl(T, Send())`/`impl(T, Sync())` under the pragma (`Channel`, `Waker`), and `enforce_atomic_object_send` (which now asks `Sync`) skips pragma'd files because their impl registers after the type. `Dyn(Trait)` is either only through an explicit bound (`_thread_marker_named_in`, `values/dyn.yo`); a `Dyn(Trait, Send)` payload must also be `Sync` until V2b, since its copies share it. A closure literal that borrows its captures (`closure_literal_is_borrowed`) is never `Send`. Every marker list (`_marker_name_of`, the step-4b re-derivation, `record_closure_capture_verdicts`, `function_value_marker`, the manual-impl pragma gate) names both. **Generation B (sharing needs `Sync`):** the `Arc`/`arc` and `RwLock` bounds are `T <: (Send, Sync)` — `Sync` because each handle or read guard reads the payload from its own thread, `Send` because the last release (and `Drop`) may run on any thread; `Arc(T)`'s own `Send`/`Sync` impls stay explicit under that bound, because the atomic-object derivation asks the payload TYPE and an `Impl(Fn)` payload is `Sync` only by value (dropping them broke `arc(closure)` across `Thread.spawn`). `Mutex`/`Channel`/`Sender`/`Receiver`/`OnceCell`/`Thread(T)` need `T <: Send` (serialized access / a moved payload); since decision 48 W2 none of them requires `Acyclic` (Rust's rule: an `Arc` cycle leaks; `plans/backlog/WEAK_AND_UNCOLLECTED_RC.md` §2), and none declares `impl(_, Acyclic())` — the marker is derived, and `Thread.spawn`/`ThreadPool`/`spawn` keep `Impl(Fn, Send)` with a `T <: Send` result. A `Send`-but-not-`Sync` type (`impl(T, !(Sync()))`) is the canary (`tests/send_sync.test.yo`). `String`/collections stay non-`Send` until V2b's unique buffers.
- **D1, module globals.** A closure bound to a `Send` or `Sync` closure type (a spawn body, a pool task, a `Dyn(Trait, Send)` method) may not reach a non-`Sync` module-level global, directly or through any function, local closure or `Send` trait object it calls. A value global that is written anywhere may not also be reached that way (a mutable static). Check: `function_reaches_non_send_global` (`src/evaluator/effects/mutation_summary.yo`). Use `thread_local(name)` for per-thread state, an atomic object for shared state. A pragma'd std file is the audited base: its globals are under a lock (`std/log.yo`, `std/encoding/html.yo`).
- **Decision 47, `mut(name)` globals.** A module-level or `thread_local` runtime binding is Rust's `static` unless declared `mut(name)` (`static mut`). Writing an unmarked one is E0917 (`global_require_mut`, `src/evaluator/utils.yo`); lending a `mut(...)` one, or a place under it, to a call is E0916 (`_check_call_global_lends`, `src/evaluator/calls/function.yo`, over `_call_lends`, which E0910 shares). A `ref` handle global needs no marker for writes through it; its lends are checked path-sensitively (rule A: `&G(i)` vs a `&mut self` call on `G`; rule B: `&H.f` vs a write of `H.f`), through two-sided registries so the verdict does not depend on evaluation order. Both rules apply everywhere, `std/` and `src/` included (Generation B dropped Generation A's exemption); a borrowing future is E0909 only for a place rooted in a `mut(G)` or `thread_local(mut(x))` binding (`_reject_global_lend_to_future`; plans/VALUES_BY_DEFAULT.md §6).
- **V2b B5, written collection globals are `RefCell` globals** (`plans/VALUES_BY_DEFAULT.md` B5, open question 1). In `src/`, a module-level `ArrayList`/`HashMap`/`HashSet` that anything writes after its initializer is declared `(g_x : RefCell(T)) = RefCell(T).new(T.new());` and used only through `g_x.with(m => m.get(k))` and `g_x.with_mut(m => m.insert(k, v))`, so it stays legal when the collections become values (B8–B11). A global nothing writes (the shared empty sentinels `g_empty_value_cell`, `g_empty_path_collection`, the read-only `g_scope_names`, and the built-once sets `BuiltinYoInlineFunctions`, `PrimitiveTypeTags`, `_c_reserved_words`) stays a plain binding; a `mut(G)` collection global written only by reassignment and read by value (`g_lb_lookahead_stmts`) is decision 47's case, not this one. Find the written ones with `YO_AUDIT_GLOBAL_LEND=1 yo check ./src` (a `recv-mut` lend or a `[global-write]` line on a collection global), not with a one-line grep: `yo fmt` wraps a long declaration onto two lines, and B5's first pass missed 26 that way. Runtime globals cannot be exported, so every use is in the declaring file. Keep each closure body to the one collection operation: an argument that can reach the same global (a recursive memo fill, `G.len()` inside `G.drain(...)`) is evaluated before the access, or the nested access panics at run time (`RefCell.with_mut: the value is already borrowed`; nested `with` reads are fine). A `return`/`break` inside the closure leaves the closure, not the function, so control flow stays outside it.
- **Decision 47 step 2, `mut(name)` locals (Generation A).** Every binding below module level (local, pattern, destructuring, `::`/`comptime(...)`) is immutable unless declared `mut(name)`; parameters take no marker (rebind). The marker is stripped in place at each binding site and recorded by the declared name's token (`register_mut_binding`), so env copies and generic re-evaluation keep it. Writes go through `binding_require_mut` / `place_require_mut` (`src/evaluator/utils.yo`): E0917 (renamed `E_IMMUTABLE_BINDING_WRITE`), exempt in `std/`, `src/`, `scripts/` and the root `build.yo` (`is_global_mut_rule_exempt`, `src/evaluator/memory_safety.yo`; the globals step no longer is), census `YO_AUDIT_MUT_BINDINGS`, migration `yo fix --migrate mut-bindings`. Collections are still `ref` handles, so their writes need no marker until V2b Generation B; that is why the src/std sweep (Generation B) follows V2b Generation B.
- **D3, no writes through an atomic object.** No `=`, index store, or `&mut` argument whose callee may write, rooted in an `Arc`/`Mutex`/`atomic(ref(...))`. The decision uses the callee's per-parameter mutation mask. A read-only `&mut self` method (`ToString`, `Hash`) through an `Arc` stays legal.
- **D8, second-class captures.** A closure may not capture a `&mut`/`ref` parameter or a control-bound value. A new rejection that fires inside a definition-time trial must be flagged with `flag_flow_violation` before it throws, or the trial swallows it. A trial's caller re-raises the flagged error with `reraise_flow_violation`, which flags it again, so it also survives a trial that encloses that definition (a handler inside an `io.async` body).
- **D4 + D9, function values.** A function value (closure or named function) holds `Send` iff what it captures is `Send` AND its code reaches no non-`Send` global; `Acyclic` is the captures alone. The VALUE decides, wherever it is known: `function_value_marker` (`src/evaluator/utils/closure.yo`, reached from `trait_checking.yo`/`types/function.yo` through `call_function_value_marker`) runs at every where-clause path, both `Impl` argument paths, `Impl` results and captures. A bare `fn(...)` type with no value (a struct field, a `Channel(fn() -> unit)` payload) is NOT `Send`, so a std type that must cross threads holds `Impl(Fn(...), Send)`, never a bare `fn` field. A new site that judges a function-typed value for a marker must pass the value as the witness, or it judges by type and rejects.
- **D6, runtime externs.** Calling a `__yo_*` runtime extern (any `extern` other than `"c"`) by name or through a module value needs the pragma. Expose a runtime entry point as a Yo wrapper function in a pragma'd module, never as a bare alias (`get_thread_id :: __yo_get_thread_id;` made every caller call the extern).
- **Rust's thread rule (D2 retired 2026-10-21, `plans/backlog/MACRO_AND_ISO_REMOVAL.md` Part A).** Data that crosses threads must itself be `Send`, and `Send` is derived purely structurally; there is no runtime uniqueness walk. An `Rc` graph is thread-local; `Rc.try_unwrap` takes the value out of a uniquely held handle. Until V2b's B8–B11 flips, `String` and the collections are not `Send`, so none crosses a thread.
- **D5 / D7, runtime.** `std/sync` primitives record their owner and trap on misuse. A thread that touches ANOTHER thread's event loop registers in the loop's `visitors` count while the loop is provably alive, and loop teardown waits for it (`__yo_async_loop_quiesce`). The loop's live-waker count drops only in the owner's drain.

## Explicit allocators: placement, not lifetime (`plans/archive/EXPLICIT_ALLOCATORS.md`)

- An `Allocator` (`std/allocator.yo`) is `{ctx, vtable}`: a two-word `Send`
  value, never reference counted. Every block it hands out carries a 16-byte
  owner prefix (`{ctx, vtable}`) in front of the returned pointer, and every
  release routes through it, so a block always returns to its allocator, on
  any thread. Codegen writes the same layout (`__yo_alloc_prefix_t`) for an RC
  object placed by a scope and marks it with the top bit of `ref_count`
  (`__YO_RC_TAG`): mask every count TEST with `__YO_RC_COUNT`, never a write.
- `with_allocator(a, f)` makes `a` current on this thread while `f` runs; the
  six user-visible RC constructor sites consult it (`__yo_rc_alloc_scoped`),
  the runtime's own blocks never do (`__yo_rc_alloc`). A task keeps the scope
  it was created in across suspensions (its resume wrapper reinstates it); a
  spawned thread starts on the global allocator.
- The mutable containers' DEFAULT constructors follow the scope
  (`ArrayList.new`/`with_capacity`, `HashMap.new`/`with_capacity`, `Deque.new`,
  and `HashSet`/`StringBuilder`/`String` through them): they read
  `current_allocator()` and behave as `new_in(a)` inside a scope, unchanged
  outside one. A lazy constructor must not stay lazy under a scope — an empty
  container records its allocator only in its buffer's prefix, so
  `HashMap.new` is eager (`new_in(a)`) there. Because std is compiled into the
  compiler by the seed, a std change that calls a new runtime hook is
  seed-gated (P3c waited for v0.2.48).
- Containers record their allocator in the top bit of a word they already
  have (ArrayList/Deque capacity, HashMap's tombstone count), never in a new
  field — the object size is measured and tuned. Read such a word through its
  masked accessor (`_cap()`, `tombstones()`).
- `Arena` (`std/arena.yo`): its state is never freed (dead states are pooled),
  so a stale `Allocator` copy panics instead of touching freed memory. Every
  handle and `Allocator` value carries the state's generation (an arena's
  `ctx` is an index+generation word, not a pointer), so a dead arena's handle
  or copy never reaches the next arena that reuses its state. The `Arena`
  handle itself is not `Send` — share the arena through its `Allocator` value.
- User-facing guide: `docs/en-US/EXPLICIT_ALLOCATORS.md` (and zh-CN). Keep it,
  `MEMORY_SAFETY.md`'s section and the core-patterns cheatsheet in step when
  the surface changes.

## SomeType

- `SomeType` automatically implements the `Runtime` trait by default.
- Never write functions to resolve `SomeType` — struct/enum/union are nominal types, replacing SomeType causes problems.
- **Never substitute SomeType within another Type.** Because many types like struct/enum/union etc in Yo are nominal type, simple substitution can break type identity. The correct approach is to re-evaluate the type expression in an environment where the type parameter is bound to the concrete type.
- **Every `Impl(Trait)` annotation wrapper is a SomeT with the RESERVED name `"Impl"`** (`src/evaluator/builtins/impl_constraint.yo`). Any evaluator logic that matches or binds SomeTs BY NAME (param↔return substitution, env markers, where-clause bookkeeping) must exclude that name (and nameless dyn wrappers) — two wrappers in one signature are unrelated. Missing the exclusion makes a call typed as one of its ARGUMENTS' types (C27, `issues/fixed/generic-impl-async-method-closure-param-return-type-collapse.md`). Do NOT "fix" it by renaming the SomeT (every `== "Impl"` reservation check breaks), by skipping its env binding (std stops checking), or by keying env bindings per id (io.async/io.await share wrapper bindings by name — `async_await` regresses).
- **A function literal (`=>`/`->`) cannot take an `Impl(Fn(...))` PARAMETER** — rejected at definition (`_is_unresolved_impl_fn_type`, `src/evaluator/values/anonymous_function.yo`). A literal has ONE lowered body, so the parameter cannot be monomorphized per call site the way a named function's can (each call's argument closure is its own capture struct); unrejected it lowered to `void*` while the call passed the struct by value: invalid C (`issues/fixed/a-closure-value-with-an-impl-fn-parameter-emits-invalid-c.md`). Take the parameter as `Dyn(Fn(...))` (one boxed calling convention) or write a named `fn`.

## Platform-specific code

Use `process.yo` module `platform` and `Platform`:

```yo
AF_INET6 :: cond(
  (platform == Platform.Darwin) => i32(30),
  true => i32(10)
);
```

Current goal: make Yo work on Linux, macOS, and Windows.

## A bare integer literal converts at argument positions, NOT as a receiver

A literal converts to any runtime integer type at ARGUMENT positions
(`xs.push(1)`, `f(0)`), but as the LEFT operand of a binary operator it does
not: `(0..n)`, `(3 == n)`, `(1 + n)` with a runtime `n` of a differing
integer type are rejected with a
phantom "runtime argument to compile-time parameter" diagnostic (OPEN
`issues/an-integer-literal-on-the-left-of-a-runtime-operand-is-rejected.md`;
measured with `usize` operands — with an `i32` `n` the same spellings can
pass, so do not rely on either direction).
Put the runtime operand on the left — `(n == 3)`, `(n + 1)`,
`usize(0)..n` — and cast both ends of an all-literal runtime range
(`i32(0)..i32(5)`).

## Verification: a green `yo verify` is not "everything proved"

`assumed` (contracts declared, body never walked) and `outside-subset` (the
function promised nothing and the walk could not enter it) PASS a plain
`yo verify` run. That is deliberate — it is what makes gradual adoption and
the `std/collections` dogfooding possible — but it means the run's exit code
alone says nothing about coverage. Two consequences when you write or review
verification work:

- Gate a specification directory with `yo verify <path> --strict`
  (= `--deny assumed,outside-subset,unproven`), which makes those outcomes
  hard failures in every mode, including `verify+`. Adding `assumed()` to
  silence a finding is then a visible change, not an invisible one.
- Read the summary line, not just the exit code: it prints all seven outcome
  counts and how many `ok` results were VACUOUS — an `ok` that discharged no
  obligation proved nothing at all. `--format json` carries the same under
  `summary`. The self-verification campaign
  (`plans/SELF_VERIFICATION.md`) ratchets on the non-vacuous count for
  exactly this reason.
- **Laws (`law(...)`) state claims OUTSIDE the code** (B1, landed
  2026-09-19): `name :: law(fn(x : T, requires(p), ensures(q)) -> unit);`
  — the argument is a written-out fn type with clauses and no body. A law
  is proved from the callee's CONTRACT alone (never its body), evaluates
  to `unit` and is erased in codegen; a non-`unit` return, no `ensures`,
  `assumed()`, `decreases(...)` or a named alias in place of the fn type
  are all compile errors, and `unproven` has no assert fallback for a law,
  so `--strict` decides. A law is never `outside-subset`. Its callee may be
  imported from another file (`spec/` layout;
  `issues/fixed/law-over-an-imported-callee-cannot-verify.md`). Full contract:
  `docs/en-US/FORMAL_VERIFICATION.md` §Laws; workflow: the yo-verification
  skill.

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

Functions that only execute at compile time (e.g., build system functions, macro-like utilities) must wrap their return type in `comptime(...)`. If the return type is not wrapped in `comptime`, the evaluator treats it as a runtime function.

```yo
// WRONG — unit return without comptime means runtime:
register_module :: (fn(comptime(config) : ModuleConfig) -> unit)({
  __yo_build_module(config);
});

// CORRECT — comptime(unit) signals compile-time only:
register_module :: (fn(comptime(config) : ModuleConfig) -> comptime(unit))({
  __yo_build_module(config);
});

// CORRECT — comptime(Step) for functions returning compile-time values:
executable :: (fn(comptime(config) : Executable) -> comptime(Step))({
  __yo_build_executable(config.name, config.root, ...);
  Step(name : config.name, kind : StepKind.Executable)
});
```

This applies to all parameters and return types in comptime-only APIs:

- Parameters: `comptime(name) : comptime_str`
- Return: `-> comptime(Step)`, `-> comptime(unit)`, `-> comptime(str)`

## Algebraic effects

- Effect handlers are **explicit parameters**. A function that uses an effect names it in its signature, e.g. `safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)`. Callers pass the handler by name at the call site: `safe_divide(i32(10), i32(0), raise)`.
- Install a handler at the use site with a local binding: `(raise : Raise) = ((msg) -> { unwind(i32(-1)); });`. Lambdas on the RHS of `=` need outer parens.
- A handler whose body may `unwind` must have type `ctl(args) -> R`. A handler that always resumes can be plain `fn(args) -> R`. Subtyping is one-way: `fn(T) -> R <: ctl(T) -> R`.
- `return(expr)` inside an effect handler **resumes** the continuation.
- `unwind(expr)` inside an effect handler **discards** the continuation and exits the install frame (the function that bound the handler). `unwind` is only valid inside a `ctl(...) -> R` body.
- For effect-bundle polymorphism, quantify over a struct: `generic(E : Type.Struct)` and pass `E` as the Future's single effect argument.
- Effect handlers use Evidence Passing (function pointer parameters) for zero-overhead calls.
- **Handler functions are standalone, not closures.** Effect handlers are compiled as standalone C functions and cannot reference variables from the enclosing scope. Pass state as explicit function arguments instead.
- Pointers/references to control-bound types (any type transitively containing a `ctl(...) -> R`) are rejected — handlers must live on the stack of the install frame.
- For the full design document with overhead analysis and implementation details, see `docs/en-US/ALGEBRAIC_EFFECTS.md`.

## Future return types with effects

- `Future` takes the result type as the first argument and (optionally) a single effect bundle as the second: `Future(T)` or `Future(T, E)`.
- `E` is a single type — typically a struct that bundles every effect the async body needs. Define one bundle struct (e.g. `Ctx :: struct(io : Io, raise : Raise)`) and pass it as the single `E`.
- The async closure takes that bundle as one parameter: `io.async((ctx : Ctx) => { ctx.raise(...); ... })`.
- When a function uses `io : Io` and runs an async body, the bundle must include `Io`, so the return type names it: `Impl(Future(Result(T, E), Ctx))`.
- Return `io.async(...)` directly as the last expression, or through an
  intermediate variable that a later statement returns (or that is the body
  tail) — both forms infer the closure's bare-variant tail from the function's
  result type
  (`issues/fixed/io-async-variant-inference-passes-check-but-fails-compile.md`):

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
```

(The async closure body above uses two statements on purpose: a
single-expression `{ ... }` body parses as a record literal — the braces
rule.)

## Async iteration — the `Stream` trait (`std/async/stream.yo`)

The async analogue of `Iterator`, landed 2026-09-11
(`plans/reference/ASYNC_ITERATION_STREAM.md`):

```yo
Stream :: trait(
  Item : Type,
  next : (fn(self : Self, io : Io) -> Impl(Future(Option(Self.Item), Io)))
);
```

Four rules to keep when extending it or implementing it on a new type:

- **The future's bundle is `Io`, never `IoExn` — a stream does not throw.** A
  fallible stream puts the failure IN the item (`Item = Result(T, E)`, e.g.
  `TcpListener.incoming`'s `Result(TcpStream, NetError)`), so one bad item
  does not end the sequence and no consumer installs a handler. The knock-on:
  an API that THROWS (`Reader.read`, `BufReader.read_line`) cannot become a
  stream until it can return its failure —
  `plans/backlog/ASYNC_LINES_NEEDS_A_NONTHROWING_READ.md`.
- **`next` takes `self : Self`, not `self : &mut Self`** (`Iterator` uses
  `&mut`): the future outlives the call and a `&mut` borrow cannot cross a
  suspension. So every source is a `ref(struct(...))`.
- **`.None` is terminal and stays terminal.** Every combinator preserves it.
- **The associated type is named `Item`**, with the same uncheckable coherence
  rule `DoubleEndedIterator` documents: the assoc-type registry is keyed by
  (type id, label) with no trait discrimination, so a type implementing both
  `Stream` and `Iterator` must give them the SAME `Item`. (`FromIterator` chose
  `Elem` to dodge this; here no std type implements both.)

The loop is written out: `mut(s) := stream;` then `while(true, …)`
around `n := io.await(s.next(io), io);` and a `match(n, .Some(x) => body,
.None => { break; })`, so `break`, `continue` and `return` work in its body.
There is deliberately no named loop form (std's `for_await` macro was deleted
on 2026-10-24, maintainer decision, `plans/reference/ASYNC_ITERATION_STREAM.md`):
**a suspension point is an `io.await` written in the `io.async` body; an
`io.await` inside a function the task calls blocks instead of suspending.** A
name that hides the await hides the suspension point, which is the whole bug
history of `for_await` (awaits inside its expansion emitted as blocking). The
same rule is why an `Iterator.next` that awaits, driven by a plain `for` inside
a task, compiles silently and serialises or deadlocks (2026-10-24 probe).

## JoinHandle(T) — spawned task handle

`JoinHandle(T)` is the prelude type `io.spawn` returns: a `ref` struct that OWNS one reference to the spawned task's future (`std/prelude.yo`, "JoinHandle — a handle to a spawned async task").

### API

```yo
handle := io.spawn(task, ctx); // → JoinHandle(T), ctx is the task's effect bundle
result := handle.await(io); // → Option(T), blocking: main / plain fns only
result := io.await(handle.join(io), io); // → Option(T), suspending: the form inside a task (std/async)
handle.state();
handle.is_finished();
handle.abort();
```

### Semantics

- **A future is move-only** (`plans/VALUES_BY_DEFAULT.md` §3.13 A1): `io.await(f, e)` and `io.spawn(f, e)` consume `f`, `io.state(&f)` borrows it. A second await, or an await after a spawn, is E0901; a result several tasks need is joined once and shared (`Rc(T)`, a channel). An `io.async` body that awaits a CAPTURED future must move it in with a by-value capture list (`io.async({ f }(io : Io) => io.await(f, io))`; an implicit capture is E0913), and a function that awaits or captures a future parameter takes it `sink(f) : Impl(Future(T, E))`.
- `io.spawn(task, e)` copies the bundle `e` into the cold future, runs the task INLINE up to its first suspension point (spawn is not itself a suspension point), and returns a `JoinHandle(T)`.
- **A future may borrow, and is then second-class** (§3.13 A2): an `io.async` body with a borrow in its capture list (`{ &x }`, `{ &mut x }`) makes a future that is awaited where it is made (`io.await(bump(&mut c, io), io)`). It may be returned only when every borrow is rooted at the returning function's own `&`/`&mut` parameters; binding it to a local, storing or spawning it is E0909, and so is lending it a place through an `Rc`/`Arc` deref (pass the handle, `h : &Rc(S)`, and read `h.*.f` inside) or a place rooted in a `mut(G)` or `thread_local(mut(x))` binding, argument or receiver (another task on the thread can reassign it during the await; lend a local copy, or read the global by name inside the future; an unmarked global is immutable and a `::` constant has no runtime storage, so both are fine). A `&T` parameter reaches C by value, so the future keeps its own copy of a lent `&` parameter (`__yo_lent_<label>`) and borrows the parameter whole: `{ &p.f }` on a `&` parameter is an error in an `io.async` capture list, and a returned future that reaches a `&T` parameter only through a closure it captures is E0909. The `Rc` rule is checked at the call that makes the future, so an `if`/`cond`/`match` arm or a block tail does not hide it, and it covers index places (`&mut xs(i)`). A call through a function value is assumed to borrow every place it lends; a match-arm binding and `_ := ...` are bindings; with a borrowing future, `io.await`'s bundle must be a place (`io`, `self.io`; E0910), and a later argument of the call that makes it may not move, assign or `&mut`-lend (also as a `&mut self` receiver) a place an earlier argument lends (E0910). `dyn(v)` is E0909 when a method of `v` in the vtable returns a borrowing future, so a future made through a `Dyn` borrows nothing.
- `handle.await(io)` returns `Option(T)`: `.Some(result)` on completion, `.None` when the task was aborted (an effect handler called `unwind`, or `handle.abort()`). **A `JoinHandle` is a move-only value (§3.13 A3): awaiting CONSUMES it** (the result moves out of the task), so a second `await` or `join` is E0901. `state()`, `is_finished()`, `abort()` and `as_ptr()` borrow it (`self : &Self`). It is a BLOCKING poll loop in every context, so inside an `io.async` body it nests the event loop (`YO_ASYNC_STRICT=1` panics there). Inside a task use **`io.await(handle.join(io), io)`** (`std/async`): the same `Option(T)` as a future that suspends the task; `join(self : Self, io)` consumes the handle too, and an `io.async` body that joins a captured handle moves it in with a capture list (`io.async({ h }(io : Io) => io.await(h.join(io), io))`). The `std/async` combinators (`join_all`, `race`, `race_first`, `any`, `any_first`, `timeout`) are futures of the same kind and take their handles BY VALUE — `io.await(join_all(handles, io), io)` in `main` and in a task alike. `join_all`/`race_first`/`any_first` drain the list and `timeout` consumes its handle; `race`/`any` hand the list back, `(w, rest) := io.await(race(handles, io), io)`, so the losers can still be aborted. Walk a handle list by borrowing elements in place (`hs(i).abort()`) and own one with `pop()`/`remove(i)`; `get(i)` copies and is E0901.
- The handle owns one reference to the task's future, and `Drop` releases it. Dropping the handle without awaiting DETACHES the task (it keeps running and frees itself when it finishes), which is what makes a fire-and-forget `io.spawn(task, e);` statement correct. Abort-on-drop is deliberately NOT the semantics.
- `JoinHandle(T)` is `!Send` and `!Sync` (the task lives on the spawner's loop thread); `Io` is `!Send` and `!Sync` too.

### Definition (in prelude.yo)

```yo
JoinHandle :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(__future : *T)
);
```

The `*(T)` field is required so the type parameter `T` appears in the struct fields, enabling the type synthesizer to extract `T` bindings during generic impl matching.

## Trait impls are visible only through the caller's imports

Method resolution (`get_visible_type_trait_methods_by_name`, env.yo; the
generic-impl fallback in impl.yo) sees an `impl` only if its registering
module is in the CURRENT module's transitive import closure, or is the
prelude. A module that calls integer/`str` `to_string` therefore imports
`std/fmt`. The closure comes from import edges recorded from each module's
SOURCE at load time (`_record_static_import_edges`, module_manager.yo), so
it does not depend on evaluation order. `YO_VISIBILITY_REPORT=1` enumerates
would-be misses instead of rejecting them — run a stage-2 emit with it to
find missing imports before they fail a batch
(issues/fixed/a-file-that-fails-check-alone-passes-inside-a-directory-check.md).

## Traits with associated types

Traits use direct `trait(...)` syntax with associated types as labeled `Type` fields:

```yo
// Trait definition — Item is an associated type. Iterator was
// migrated to take self : &mut Self in plans/archive/ITERATOR_REDESIGN.md
// (the old *(Self) signature would be forbidden in safe code).
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

- **`:` in impl** creates a TraitValue (provides all fields).
- **`:=` in where clause** creates a specialized TraitType (constrains associated types only).
- Always wrap `fn` types in parentheses inside trait field definitions: `next : (fn(...) -> T)`, not `next : fn(...) -> T`.

## Trait method disambiguation with where-clause constraints

When a type implements multiple traits that each define a method with the same name, where-clause constraints disambiguate which trait's method is used:

```yo
T1 :: trait(get_number : (fn(self : Self) -> i32));
T2 :: trait(get_number : (fn(self : Self) -> i32));

Point :: struct(x : i32, y : i32);
impl(Point, T1(get_number : (self -> self.x)));
impl(Point, T2(get_number : (self -> self.y)));

// Implicit dispatch — where(T <: T1) constrains self.get_number() to T1's method
use_t1 :: (fn(generic(T : Type), self : T, where(T <: T1)) -> i32)({
  return(self.get_number()); // Dispatches to T1.get_number -> returns x
});

// Explicit dispatch — (T <: T2).get_number accesses T2's method directly
use_t2 :: (fn(generic(T : Type), self : T, where(T <: T2)) -> i32)({
  return((T <: T2).get_number(self)); // Dispatches to T2.get_number -> returns y
});
```

**Implementation details:**

- Where-clause constraints are applied BEFORE argument binding so the SomeType has trait constraints during method lookup
- Runtime parameters with constrained SomeType stay typed as the SomeType (not the concrete arg type) to preserve trait filtering
- `getReceiverMethodsByNameFromEnv` filters impl'd traits by the SomeType's where-clause constraint IDs
- Concrete FunctionValues are resolved from trait impls for codegen static dispatch (avoids vtable-style dispatch)

## Comptime/runtime function specialization

Yo does **not** support function overloading — same stance as Rust, and ENFORCED since 2026-08-21 (`plans/reference/FUNCTION_OVERLOADING_POLICY.md`): an exported `Call` holding a tuple of two or more candidates is rejected everywhere except std/prelude.yo, whose runtime/comptime operator modules (`(-)`/`(!)`/`(~)`, `Call :: (neg, comptime_neg)`) are the single sanctioned overload sets (`is_overload_set_capable_file` in `src/evaluator/memory_safety.yo`, gated at the export choke point in `src/evaluator/values/anonymous_module.yo`). A single-function `Call` — a callable module — is not an overload set and stays allowed. To provide comptime variants of functions, use explicit naming with a `comptime_` prefix (e.g., `comptime_unwrap` alongside `unwrap`).

Use separate `impl` blocks with `where(Self <: Comptime)` constraints for comptime method variants on generic types like `Option(T)` and `Result(T, E)`.

**Duplicate method names across impl blocks are disallowed** — ENFORCED since 2026-08-21: a second same-name INHERENT impl for the same type errors with `Method "X" is already defined for this type` (gated at inherent registration in `src/evaluator/values/impl.yo`, keyed on the defining site so loader re-evaluation and per-instantiation generic re-registration stay legal — `plans/backlog/DUPLICATE_INHERENT_METHOD_REJECTION.md`). Trait-provided methods sharing a name remain legal by design. Use distinct names (e.g., `comptime_unwrap`) for variants. This ensures unambiguous method extraction via `Type.method_name`.

**Enum type method extraction** works: `Option(i32).unwrap` returns the method as a callable function value, matching struct type behavior.

## Operator traits use associated type Output

All operator traits (Add, Sub, Mul, Div, Mod, BitAnd, BitOr, BitXor, BitLeftShift, BitRightShift, Exponentiation, Negate, BitNot) use `Output` as an **associated type** in the trait body — the same pattern as the `Index` trait. The `Output` is NOT a function parameter.

Binary operator traits take `Rhs` as a type parameter. Their operands are BY VALUE, as in Rust's `Add::add(self, rhs)` (decision 34 as amended 2026-10-11); only `Eq`, `Ord`, `ComptimeEq` and `ComptimeOrd` borrow (`lhs : &Self, rhs : &Rhs`). An impl writes exactly the trait's modes:

```yo
Add :: (fn(comptime(Rhs) : Type) -> comptime(Trait))(
  trait(
    Output : Type,
    (+) : (fn(lhs : Self, rhs : Rhs) -> Self.Output)
  )
);
```

Unary operator traits (Negate, BitNot) are parameterless:

```yo
Negate :: trait(
  Output : Type,
  neg : (fn(self : Self) -> Self.Output)
);
```

Comptime variants add `where(Self <: Comptime, Self.Output <: Comptime)`:

```yo
ComptimeAdd :: (fn(comptime(Rhs) : Type, where(Rhs <: Comptime)) -> comptime(Trait))(
  trait(
    Output : Type,
    (+) : (fn(comptime(lhs) : Self, comptime(rhs) : Rhs) -> comptime(Self.Output)),
    where(Self <: Comptime, Self.Output <: Comptime)
  )
);
```

Impls must provide `Output : Type` explicitly:

```yo
impl(
  i32,
  Add(i32)(
    Output : i32,
    (+) : ((lhs, rhs) -> __yo_op_add(lhs, rhs))
  )
);

impl(
  i32,
  Negate(
    Output : i32,
    neg : (self -> __yo_op_neg(self))
  )
);
```

## Higher-Kinded Types (HKT)

Yo supports HKT by using **comptime function types as kinds**. Type constructors like `Option` and `Result` are already first-class comptime functions — HKT lets you abstract over them.

### Function-typed generic parameters

Declare a generic parameter with a function-type kind to accept type constructors:

```yo
// F is a type constructor (kind: Type → Type)
identity :: (fn(generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type), x : F(A)) -> F(A))(x);
```

### HKT traits

Define traits parameterized by type constructors:

```yo
Functor :: (fn(comptime(F) : (fn(comptime(T) : Type) -> comptime(Type))) -> comptime(Type))(
  trait(
    map : (fn(generic(A : Type, B : Type), self : F(A), f : Impl(Fn(a : A) -> B)) -> F(B))
  )
);
```

### Where clauses with TypeApplication

Use `where(F(A) <: SomeTrait(F))` to constrain type constructor applications:

```yo
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

### TypeApplication resolution

`TypeApplication` (`F(A)`) is compile-time only — it gets fully resolved during specialization and must never reach codegen.

## Partial Application with `_`

Multi-parameter comptime functions can be partially applied using `_` as a placeholder:

```yo
// Type constructors:
IntResult :: Result(_, i32); // kind: Type -> Type
StrResult :: Result(str, _); // kind: Type -> Type

// Comptime value functions:
add :: (fn(comptime(x) : i32, comptime(y) : i32) -> comptime(i32))(x + y);
add1 :: add(i32(1), _); // fn(comptime(__0) : i32) -> comptime(i32)
result :: add1(i32(2)); // 3
```

Partial application works on **any** comptime function (functions whose return type is `comptime`). It cannot be used on runtime functions.

## Option and Result combinators

`Option(T)` and `Result(T, E)` provide Rust-style combinator methods. Key methods:

- **Option**: `map`, `and_then`, `filter`, `or_else`, `flatten`, `map_or`, `map_or_else`, `ok_or`, `ok_or_else`, `and`, `or`, `unwrap_or_else`
- **Result**: `map`, `map_err`, `and_then`, `or_else`, `and`, `or`, `ok`, `err`, `map_or`, `map_or_else`, `unwrap_or_else`

Combinators use `Impl(Fn(...))` callbacks, and the generic type parameter is inferred automatically. Lambda syntax `(a) => expr` works too — parameter types are inferred from context:

```yo
(x : Option(i32)) = .Some(i32(5));

// Lambda with fully inferred types:
result := x.map(a => (a * i32(2)));
// result = .Some(i32(10))

chained := x.and_then(
  a =>
    cond((a > i32(0)) => Option(i32).Some(a * i32(2)), true => Option(i32).None)
);
```

## Generalized Algebraic Data Types (GADTs)

GADTs extend enum types with per-constructor return type annotations using `-> recur(...)`:

```yo
Value :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    IntVal(i : i32) -> recur(i32),
    BoolVal(b : bool) -> recur(bool),
    PairVal(a : i32, b : bool) -> recur(i32)
  )
);
```

Key semantics:

- `-> recur(ConcreteType)` after variant fields specifies what type the constructor produces
- When omitted, defaults to the unconstrained type parameters (regular enum behavior)
- Match type refinement: in `match(v, .IntVal(i) => i, .BoolVal(b) => b)`, each branch refines T to the variant's declared type
- Exhaustiveness: unreachable variants (e.g., `BoolVal` when matching `Value(i32)`) are excluded from exhaustiveness checking
- Runtime representation is identical to regular enums — all GADT logic is erased at compile time
- GADTs with custom discriminants: wrap variant in parens `(TagInt(i : i32) -> recur(i32)) = 10`
- Mixed GADT/regular variants: some variants can have `-> recur(...)` while others remain unconstrained
- For full design document, see `plans/reference/GADTS.md` and `docs/en-US/GADTS.md`

## std error handling: three blessed styles, no fourth

Decided in `plans/archive/STD_API_AUDIT.md` D1. Before this, std shipped four styles,
sometimes inside one file. When you add or change a fallible std API, pick from
exactly these three — and if none fits, that is a design discussion, not a
licence to invent a fourth.

| Situation | Style |
| --- | --- |
| I/O, and anything on the `io` path (fs, net, http, process) | **effects** — `exn : Exception` / `IoExn` |
| pure fallible transforms: parsing, decoding, conversion | **`Result(T, TypedError)`** |
| lookups where absence is not an error | **`Option(T)`** |

Rules that follow from it:

- **`Result(_, String)` is banned.** An error type is a real enum implementing
  `Error()`. A string error cannot be matched on, downcast, or wrapped, and it
  forces every caller into prose comparison. Since 2026-09-05 the `Error()`
  marker is **enforced, not decorative**: `dyn(x)` checks that `x`'s type
  implements every required trait of the `Dyn` it is boxed into, so
  `exn.throw(dyn(e))` on an error enum without `impl(E, Error())` is a compile
  error at the `dyn(...)` token (it used to fail inside the C compiler, naming a
  generated `__yo_wrap_…` symbol — see
  `issues/fixed/dyn-does-not-check-that-the-value-implements-the-traits.md`).
- **Spell an error enum with `derive(T, Error)`, not two hand-written impls.**
  One message per variant, in DECLARATION ORDER, emits `ToString` and `Error`
  together; each message is checked against the variant it lands on, so a
  renamed/added/removed/reordered variant is a compile error.

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

  The message is ordinary Yo spliced into the arm that binds the payload, so
  `${pos}` is the variant's own field — not a positional `{0}`. Write the two
  impls by hand only when the render is not one message per variant (a struct
  error, or a body that needs a local).
  `Error` carries `where(Self <: ToString)`, so `ToString` is required too.
- **Never drop the payload on failure.** `Channel.send` returning
  `Result(unit, unit)` discarded the value the caller still owned; return it.
- A fallible constructor that cannot fail should not be fallible — do not add a
  `Result` "for symmetry".
- Absence and failure are different: do not model a missing key as an error, and
  do not model an I/O failure as `None`.

## std naming conventions

Decided in `plans/archive/STD_API_AUDIT.md` D2. One name per concept, across the whole
tree. Use these when adding an API; a new module that invents a synonym is a
review defect, not a style preference.

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

A rename sweep must also rewrite the `test("<Type>.<method> …")` name strings
that spell a renamed method (and any comment naming it): `--test-name-pattern`
matches those strings, so a name left on the old spelling hides the test from
the pattern that targets the method and offers phantom matches for a method
that no longer exists (2026-10-03: 37 collection tests were still named
`add`/`has`/`set`/`min`/`max`/`iter_ptr` a month after the rename —
`issues/fixed/collection-test-names-still-use-pre-rename-method-spellings.md`).

Two conventions that are easy to miss:

- **`sys/` is plumbing, `std/*` is the product.** Every user-relevant syscall
  gets a typed wrapper, and an underscore-private name must never appear in an
  `export(...)` list. For struct fields and impl methods the `_` prefix is not
  a convention but the visibility rule the compiler enforces (E0405,
  `plans/reference/MEMBER_VISIBILITY.md`): private to the declaring module and
  its same-directory siblings, so a `_` member another directory needs is an
  API gap to close with a public method, never a reason to reach in.
- **Traits are the API.** An inherent method that duplicates a trait method
  becomes a trait impl, so generic code can dispatch on it. Types that should
  compose get `Eq` / `Ord` / `Hash` / `Clone` / `ToString`.
- **Hashing is Rust-shaped (plans/reference/HASHER_REDESIGN.md).** `Hash.hash(self : &Self,
  hasher : &mut H)` FEEDS bytes; a `Hasher` (`std/hash`: `SipHasher13` =
  `DefaultHasher`, `Fnv1aHasher`) turns them into the `u64`. Never write a
  `-> u64` hash method or fold hashes with `* 31`; a new type's impl calls
  `hasher.write_*` per field (or `derive(T, Hash)`), variable-length data writes a
  terminator/length, and `hash_one(&v)` is the one-value helper. Maps use FIXED
  default keys so emitted C and printed maps are reproducible (the fixpoint
  gate compares C byte for byte); `HashMap.with_keys` is the per-instance opt-in.

## UTF-8 lives in exactly one module

`std/encoding/utf8.yo` is the only place in the tree that is allowed to know how
UTF-8 is laid out. Before it landed, **eleven** `std/` files carried their own
copy of the same bit twiddling (STD_API_AUDIT D8), and three latent bugs were
hiding in the copies. Do not add a twelfth.

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

Two constraints on that module you must not break:

- **It stays below `std/error` and `std/fmt`.** It imports only
  `std/string/rune` and `std/collections/array_list`, because
  `std/string/string.yo` is a consumer and `std/error`/`std/fmt` both import
  `std/string`. That is why `Utf8Error` has inherent `message()`/`index()`
  instead of `ToString`/`Error()` impls — same reason `AllocError` has none.
  A module that wants a throwable UTF-8 error wraps it, the way
  `StringError.InvalidUtf8(cause : Utf8Error)` does.
- **`String.from_bytes` does not validate** — it is the *unchecked*
  constructor, and its ~170 call sites (26 of them in `vendor/markdown_yo`) are
  why it still has that name. Use `String.from_utf8` for bytes of unknown
  provenance: a file, a socket, a subprocess, a decoded payload. Use
  `from_bytes` only when the bytes demonstrably came from UTF-8 already.
  `String.from_cstr` does not validate either, deliberately: it is how every
  `${number}` in every template string is built.

## Standard library module organization (`std/`)

## Function-type re-evaluation during impl specialization

> **Provenance: these invariants were derived on the retired TypeScript
> evaluator**, where the pass was a single function called
> `reEvaluateFunctionType`. The self-hosted evaluator has no function by that
> name (older `plans/` and `issues/` docs still use it); the work happens inside
> generic-impl specialization in `src/evaluator/values/impl.yo`. The
> invariants themselves still hold, because the frame-level check they protect
> is live in `src/evaluator/exprs/assignment.yo` (~line 1075).

Re-evaluating a function type's parameter/return type expressions with concrete substitutions during generic impl specialization has to preserve these:

- The **returned env** must have the same frame count as the specialization env. Using the function type's own captured env (the original definition scope) adds extra frames from impl field list evaluation, breaking the "defined outside the function body" frame-level check in `assignment.yo`.
- The **re-evaluation env** can differ from the returned env — it's used only for evaluating type expressions and can include extra scope (HKT variables like `F`).
- Variables from the captured env that don't exist in the specialization env (e.g., `F` from HKT trait scopes) must be merged into the returned env, because the parameters' stored type expressions still reference the original expressions.
- Parameters retain their **original** source type expressions (e.g., `F(A)` from a trait definition), so every re-evaluation needs the same variables available.

### Which env goes where

| Purpose                                     | Use                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| Returned function type's captured env       | the specialization env (correct frame count) + merged missing vars      |
| Re-evaluating the stored type expressions   | an env built from the function type's captured env (has all scope vars) |
| Frame-level checks in `assignment.yo`       | compared against the captured env's frame count                         |

### Standard library module organization (`std/`)

### When to use `index.yo`

Only create `index.yo` when the directory contains a **single public module file whose name duplicates the directory name** (the `dir/dir.yo` pattern). Rename that file to `index.yo` so users get clean imports without repetition:

```yo
// std/url/url.yo → std/url/index.yo
// Users write:
{ Url } :: import("std/url");
// Instead of the redundant:
{ Url } :: import("std/url/url");
```

Modules that follow this pattern: `std/url`, `std/regex`, `std/glob`, `std/log`.

### Flat `.yo` file for truly single-file modules

If a module has **only one file and no planned submodules**, keep it as a flat `.yo` file in its parent directory — do **not** create a subdirectory just to house an `index.yo`:

```
// CORRECT — single-file module as a flat file:
std/env.yo        ← import "std/env"

// WRONG — unnecessary directory with a single index.yo:
std/env/index.yo  ← same import path, but adds a directory for no reason
```

Use a directory with `index.yo` only when the module already has or plans to have companion files (helpers, platform-specific splits, sub-APIs).

### When NOT to use `index.yo`

Do **not** create `index.yo` re-export files for directories with multiple distinct submodules. Users should import each submodule explicitly:

```yo
// CORRECT — explicit submodule imports:
{ TcpStream } :: import("std/net/tcp");
{ HashMap } :: import("std/collections/hash_map");
{ File } :: import("std/fs/file");

// WRONG — don't create catch-all index.yo for these:
// { ... } :: import("std/net"); // which module? tcp? udp? dns?
// { ... } :: import("std/fs");  // which module? file? dir? walker?
```

Modules in this category: `std/net`, `std/fs`, `std/sync`, `std/time`, `std/crypto`, `std/encoding`, `std/collections`, `std/cli`, `std/testing`.

### Multi-file modules with a primary file

When a directory has a primary public file matching the directory name **plus** additional files, use an `index.yo` that re-exports all public submodules:

```yo
// std/http/ has http.yo (types) + client.yo (async fetch)
// std/http/index.yo re-exports both:
_http :: import("./http.yo");
_client :: import("./client.yo");
export(...(_http), ...(_client));

// Users write:
{ HttpRequest, fetch } :: import("std/http");
```

## Index trait (unified indexing)

All container indexing uses the `Index` trait. Array/Slice have special compiler builtins to avoid infinite recursion.

### Architecture

- `Index(Idx)` — runtime indexing trait with associated type `Output`. Self is taken by `self : &mut Self` so the index method can return a pointer to a field of the caller's value.
- `ComptimeIndex(Idx)` — compile-time variant (parameters and return are `comptime`). Self is taken by `comptime(self) : &mut Self` — the comptime binding is erased at runtime but mutations through it propagate to the caller via the evaluator's binding-update path.
- Array/Slice Index impls delegate to compiler builtins (`__yo_array_index`, `__yo_slice_index`, etc.)
- Other types (ArrayList, HashMap, BTreeMap, Deque, String) implement Index with normal methods

### Array/Slice builtins

| Runtime builtin                    | Comptime builtin                            | Purpose                 |
| ---------------------------------- | ------------------------------------------- | ----------------------- |
| `__yo_array_index`                 | `__yo_comptime_array_index`                 | Element access          |
| `__yo_slice_index`                 | `__yo_comptime_slice_index`                 | Element access          |
| `__yo_array_index_range`           | `__yo_comptime_array_index_range`           | Range slicing           |
| `__yo_array_index_range_inclusive` | `__yo_comptime_array_index_range_inclusive` | Inclusive range slicing |
| `__yo_slice_index_range`           | `__yo_comptime_slice_index_range`           | Range slicing           |
| `__yo_slice_index_range_inclusive` | `__yo_comptime_slice_index_range_inclusive` | Inclusive range slicing |

Runtime builtins generate inline C code (`(&(arr->data[idx]))`). Comptime builtins handle bounds checking, value extraction, and `arrayElementRef` for mutation.

### comptime_str indexing

`comptime_str` supports indexing via `ComptimeIndex`. Since D4 PR 7
(2026-08-26) the indices are **BYTE offsets**, matching the runtime basis:

- `"Hello"(0)` → `"H"` — the RUNE starting at byte 0, as a 1-rune comptime_str
  (a runtime `String` has no `s(i)`; its `byte_at(i)` yields the `u8`
  instead; that result-type split is deliberate — see `docs/en-US/STRINGS.md`)
- `"Hello"(0..3)` → `"Hel"` (byte-range slicing)
- `"Hello"(0..=2)` → `"Hel"` (inclusive byte-range slicing)
- an offset inside a rune is a **compile error** (where the runtime
  `substring` panics); out of range is a compile error too

Builtins: `__yo_comptime_string_index`, `__yo_comptime_string_index_range`, `__yo_comptime_string_index_range_inclusive`

### Self.Output resolution in generic impls

When a type has multiple Index impls (e.g., `Index(usize)` and `Index(Range(usize))`), `Self.Output` is resolved by:

1. The associated-type field expressions are extracted from the impl body args (e.g., `Output : T`)
2. The re-evaluation loop in `find_methods_from_generic_impls` (`src/evaluator/values/impl.yo`) evaluates these expressions with concrete substitutions
3. `src/evaluator/exprs/property_access.yo` checks the env for `Output` before calling `find_associated_type_from_generic_impls` (which would be ambiguous)

### Comptime element pointers for comptime mutation

Comptime array indexing returns a comptime element pointer —
`EvalValue.PtrVal(target_value, target_index)` in `src/value.yo`, where
`target_value(0)` is the backing `ArrayVal` and `target_index` is the element
index. That enables:

- `arr(0) = val` — compile-time mutation via `src/evaluator/exprs/assignment.yo`
- `addr_of(arr(0))` — compile-time pointer creation via `src/evaluator/builtins/ptr_fns.yo`

## Compiler-source (`src/`) pitfalls

These patterns bite when writing or editing the compiler's own Yo source.
They were catalogued during the TypeScript → Yo port (hence the TS-vs-Yo
contrasts below); `yo check ./src` is what catches them:

### Reference-semantics parameters: never use `addr_of()` for Environment/EvalContext

`Environment` and `EvalContext` are `ref(struct(...))` types (reference-counted),
not value types. Mutations to a reference-semantics value's fields are visible to all
holders of the reference. Using `addr_of(env)` creates a pointer-to-pointer
(`*(Environment)`) which won't match `Environment`.

```yo
// WRONG — addr_of() creates a pointer-to-pointer, a type mismatch:
_some_fn(addr_of(ee), addr_of(ge));

// CORRECT — just pass the reference-semantics value:
_some_fn(ee, ge);
```

### Reassigning Effect-handler parameters: use field-level copy

Function parameters in Yo are immutable. To "reassign" an effect-handler
variable that was passed in (e.g., `env`, `expected_env`, `env_mut`),
use field-level assignment instead of variable reassignment:

```yo
// WRONG — cannot reassign parameter:
env_mut = result.env;

// CORRECT — take over the other env's fields through the one helper:
env_adopt(&env_mut, &result.env);
```

`env_adopt` (`src/env.yo`) is the only way to take over another env: it
shares the frame list (`Rc`, copy-on-write on the next push/pop) and the
other fields, and runs the `YO_DEBUG_FROZEN` guard on the target. Do not
write the fields one by one.

### `io.async` closures: one parameter, effects struct

`io.async` takes one closure argument typed `Impl(Fn(e : E) -> T)` and returns
`Impl(Future(T, E))` (`std/prelude.yo`). The closure takes exactly
one parameter — the **effects struct** `e : E`. When the future needs
`IoExn` effects, the parameter type is `IoExn`, and all effect operations
go through `e.io` and `e.exn`. The closure body must NOT capture `io` or
`exn` from the enclosing scope (CTL values cannot be captured).

```yo
// WRONG — two parameters:
io.async((io, exn) => { ... });

// WRONG — captures enclosing io (CTL capture error):
io.async((e : IoExn) => {
  io.await(future, io); // captured io!
});

// CORRECT — all effects through e:
io.async((e : IoExn) => {
  e.io.await(create_dir_all(path, e.io), e);
  e.exn.throw(dyn(`error`));
});
```

For `Io`-only futures, use `(io : Io) =>` — just the `Io` handler:

```yo
// Io-only future: closure parameter is just Io
io.async((io : Io) => {
  io.await(some_io_future(io), io);
});
```

### `io.await` effect records: match the future's effects type

`io.await(future, e)` takes `e : E` where `E` matches the future's effects:

- `Future(T, Io)` → `io.await(future, io)`
- `Future(T, IoExn)` → `e.io.await(future, e)` (using `e : IoExn`)
- Low-level IO futures (`IO_*`) → `io.await(future, io)` only

### Exception threading: always add `exn` to calls

The evaluator threads `Exception` explicitly as the last parameter of every
function that may error — Yo has no ambient `throw`. Any new fallible helper
needs `exn : Exception` as its last parameter, passed on to all callees:

```yo
// Raise an error:
exn.throw(dyn(format_error_message(...)));

// Call a fallible helper — exn goes last:
evaluate_type_annotation(expr, env, ctx, exn);
```

### `.*` pointer dereference in check mode

`env_ptr.*` and other `.*` patterns are C-level pointer operations.
In `check` mode (no codegen), write field-level operations directly
on the reference-semantics value:

```yo
// WRONG — C pointer deref fails in check:
env_ptr.* = info.env;

// CORRECT — take over the recorded env through the helper:
env_adopt(&env_ptr, &info.env);
```
