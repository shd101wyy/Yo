---
applyTo: "**/*.yo"
description: "Use when writing or editing Yo code: how everything is spelled — braces, calls, operators, functions, closures, parameters and borrows, bindings, match patterns, imports, strings, unsafe/FFI and contracts."
---

# Yo Language Syntax Rules

## Curly braces: `.{ … }` is a record, `{ names }` on a binding side picks fields, every other `{ … }` is a block

`plans/reference/BRACE_BLOCKS.md`.

- **A record value is always `.{ … }`**: `.{ x : 1, y : 2 }`, `.{ x, y }` (puns), `.{ x }`, `.{}` (empty
  record), `.{ &y }`, `.{ ...base, x : 1 }`. With an expected struct type it is that type's value
  (`(p : Point) = .{ x : 1, y : 2 }`), as `.Some(x)` is the expected enum's; with none it is an anonymous
  record. Effect records and build options too: `io.await(fut, .{ io, exn })`,
  `build.executable(.{ name : "n", root : "r" })`.
- **A bare `{ … }` in expression position is a block**: `{ e }` yields `e`, `{ s; e }` yields `e`, `{ s; }`
  and `{}` yield unit. A `,` or `label : value` directly inside a bare expression brace is E0007 (its
  `yo fix` repair inserts the dot).
- **Binder positions keep bare braces** (a field list, no dot): `{ a } := s`, `{ a : alias } = s`,
  `{ String } :: import("std/string")`, `{ ... } :: import("m")`, `match(p, { x, y } => …)`, `.V({ x })` /
  `.V({})` in a pattern, the closure capture list `{ y }(p) => …`, `{}() => …`. A dot there is E0007 (the
  repair deletes it).
- `(a, b)` is the only tuple spelling (`.{ 1, 2 }` is E0007 naming it); `Point(x : 1, y : 2)` is a named
  struct's constructor.
- Record fields use spaces around `:`, and an infix field value is grouped: `.{ x : (1 + 2), y : 3 }`.
- Diagnostics print a record as `_(x : …, y : …)` (the parser's internal form).

```yo ignore
r := .{ x : i32(1), y : i32(2) }; // a record
v := { x };                        // a block yielding x
{ x, y } := r;                     // a field list (binder)
noop :: (fn() -> unit)({});        // the empty block is unit
io.async((io : Io) => { cond(done => .Ok(()), true => .Err(e)) }) // a block yielding the cond
```

## Calls: always immediate parentheses

- `func(a, b)`; never `func (a, b)` (space) or `func a, b` (paren-less, E0008).
- Keywords and control flow too: `cond(...)`, `match(...)`, `return(value)`, `return()`, `unwind(value)`,
  `unwind()`. `return expr` is invalid; inside a `cond`/`match` arm use a block:
  `.None => { return(x); }`. When the whole body is one `match`/`cond`, use the expression body form and
  skip `return`.
- Write `cond(condition => result, true => default)`.
- In an effect handler (`Exception(throw : (err) -> { ... })`) that does not resume normally, end with
  `unwind(...)` / `unwind()`: a call like `exit(int(1))` returns `unit`, which does not satisfy the
  handler's `ResumeType`. `unwind` needs the handler typed `ctl(...) -> R`, which it is when bound to a
  `ctl` field such as `Exception.throw`.
- Inside `quote(...)`: `unquote(expr)` and `unquote_splicing(exprs)` (words only; `#(expr)` / `...#(exprs)`
  are lex errors naming the word). Dynamic field access groups after the dot: `value.(unquote(field_expr))`.
- **Defining a macro** (a `quote(...)` parameter or `unquote(...)` return type) requires
  `pragma(Pragma.AllowMacroDef);` at the top of the file, std included (`is_macro_def_capable_file`,
  `src/evaluator/memory-safety.yo`; `plans/reference/MACRO_POLICY.md`). Calling macros and working with
  quoted `Expr` values is ungated. There is no std `try` macro: match on the `Result`.
- `impl(...)` at top level is a statement and needs its trailing `;` (without it the next line fails as a
  paren-less call, E0008).

### `if` is sugar for `cond`

`if(...)` is rewritten to `cond(...)` at parse time (`desugar_if_calls`, `src/expr.yo`); an `if` the
desugar cannot rewrite (odd arity, mismatched labels, a built AST) is an error.

```yo ignore
if(condition, then_body)        // → cond(condition => then_body, true => ())
if(condition, then_body, else)  // → cond(condition => then_body, true => else)
```

Use `if` for two-branch conditionals and comptime early-return guards; `cond` for more branches or large
ones.

```yo
if(arch == Arch.Wasm32, {
  printf("  skipped on wasm32\n");
  return();
});
```

## Operators

### No operator precedence

`plans/reference/OPERATOR_SET_AND_PRECEDENCE.md`.

1. **A chain of ONE operator left-associates at any length**: `a + b + c` is `(a + b) + c`,
   `a - b - c - d` is `(((a - b) - c) - d)`, `(A | B | C | D)` needs nothing.
2. **Adjacent DIFFERENT operators need parentheses**, else a parse error ("Adjacent different operators
   need parentheses to clarify grouping"): `(a + b) * c`, `((value <= 0x10FFFF) && ((value < 0xD800) || (value > 0xDFFF)))`.

Layout never affects grouping (no newline-based associativity).

Yo has no compound assignment: `x += 1`, `flags |= m`, `bits <<= 1` (and `-`, `*`, `/`, `%`, `&`, `^`, `>>`)
are E0010, written `x = (x + 1)`; `yo fix` rewrites the one-line form.

`:`, `:=`, `=`, `::` and `->` are ordinary operators, so a different operator beside them needs a group:
`x := a + b;` is E0003 — write `x := (a + b);`, `ok := (p && q);`, `end : (j + usize(1))`.

```yo ignore
next : (fn(self : &mut Self) -> Option(Self.Item)) // `:` vs `->`: wrap the fn type
FuncType :: (fn() -> void)                         // `::` vs `->`
(err1 : AnyError) = dyn(Box.new(ErrA(`error A`))); // `:` vs `=`: wrap the typed binding
is_neg := ((a == "-") && (b == 1));                // `:=` vs `&&`
```

### Prefix operators bind exactly ONE postfix expression

`plans/reference/PREFIX_OPERATOR_OPERAND_RULE.md` Rule 1. A bare prefix operator (`-` `!` `~` `&` `*` `?`)
binds one postfix expression — the primary plus its dot-chains and calls — and nothing more. A
no-whitespace `(` after the operator is the call form (`-(x)`, `!(ready)`). Prefer the bare form.

```yo ignore
x := -1;
assert(!d.is_empty(), "bare prefix binds the whole call chain");
show(&x);       // lends x to a `&T` parameter
t :: ?*u8;      // = ?(*(u8)) — Option of raw pointer
y := 3 - -3;    // infix minus, then prefix minus
-(1 + 2)        // an INFIX operand needs parens; -1 + 2 is (-1) + 2
!x && y         // (NOT x) AND y
!(x && y)       // NOT (x AND y)
call(&x, y)     // lends x, passes y (same as call(&(x), y))
```

- `&x` is only a borrow marker (decision 33); a raw pointer is `addr_of(x)`.
- **`*T(x)` is not a pointer cast**: `*void(p)` parses as `*(void(p))` and is rejected
  (`src/evaluator/calls/pointer.yo`). Write `(*void)(buf)`; `yo fmt` rewrites any prefix call in callee
  position to this form (`*(u8)(s)` → `(*u8)(s)`, `*(*(u8))(p)` → `(**u8)(p)`, `-(x)(y)` → `(-x)(y)`;
  `plans/reference/FMT_CALLEE_PREFIX_CANONICALIZATION.md`). In type position `**i32` is pointer-to-pointer
  and `?*u8` the optional pointer.
- Tight forms stay tight: `?T`, `?*T`, `T <: !Runtime` (never `? T` / `! Runtime`); fmt keeps `- -1`
  spaced and never tightens a pair that would re-lex as one token (`& &x`).
- Pointer dereference is `ptr.*`.

### The operator token set is closed

A run of operator characters is split greedily against the fixed table in `src/lexer.yo`
(`_is_two_char_operator` / `_is_one_char_operator`); an unknown run is a lex error, and `**x` lexes as
`*`,`*`,`x`. Reserved operators (`= := :: : => -> <: ?= && ||`, ranges) can never be bound or overloaded
(`is_reserved_operator_name`, `src/token.yo`). A new operator is a deliberate lexer-table edit.

### Paren hygiene: what `yo fmt` elides and keeps

`yo fmt` elides provably redundant parens and keeps every load-bearing group (a re-parse AST-equality gate
guards it; `plans/archive/FMT_PAREN_ELISION.md`). Write the bare forms directly.

- **Elided:** prefix calls (`-x`, `!flag`, `?*T`, `**T`, `-p.a`, `-f(x)`); atom-like operands
  (`x + y`, `y := -x`); left same-operator chains (`a + b + c`); a whole call argument (`f(a + b)`,
  `if(x == y, { ... })`, `assert(a == b, "m")`); lambda parameters (`err -> { ... }`).
- **Kept:** an operator's infix RHS (`y := (1 + 2)`, `true => (x / y)`, `.{ x : (1 + 2), y : 3 }`);
  mixed-operator groups (`(a + b) * c`); right operands (`3 + (4 - 5)` and `3 + (4 + 5)`); prefix calls
  with infix arguments (`-(1 + 2)`); the operand call of an operator with no bare prefix form
  (`...(entries)`); multi-argument operator calls (`-(a, b)`) and operator atoms (`(!)`).
- Single-line collection and tuple literals stay compact inside a multiline call: `[1, 2, 3]`, `(1, 2, 3)`.

## Reserved and discard names

- **Builtin-dispatch names cannot be bound** at any binding site (`::`, `:=`, `(x : T) =`, a destructuring
  rename): E0407 "… names a builtin: every call with this name dispatches to the builtin, so a user binding
  could never run". The set is `is_reserved_builtin_binding_name` (`src/token.yo`): `type_of` `size_of`
  `align_of` `type_id` `addr_of` `runtime` `unwind` `recur` `consume` `unsafe` `pragma` `asm` `global_asm`
  `macro_expand` `va_start` `comptime_assert` `comptime_fn` `comptime_print` `comptime_eval`
  `comptime_read_file` `comptime_json_parse` `comptime_toml_parse` `requires` `ensures` `invariant`
  `decreases` `assumed` `___drop` `___dup` `dyn` `the` `as` `clone` `quote` `downcast` `upcast` `ref_count`
  `begin` `tuple` `array` `mut` `__yo_cell` `__yo_atomic_cell`. `std/prelude.yo` is exempt.
- **`__yo_` is the compiler's namespace** (VERDICTS-72): an `extern(...)` member of either ABI, or a
  `c_include(...)` member labelled with one, named `__yo_…` and declared outside the std tree is E0407;
  `pragma(Pragma.AllowUnsafe)` does not unlock it, and `src/`/`tests/` are user code (errno is
  `std/libc/errno`'s `last_errno()`, the I/O backend teardown `std/sys/process`'s `reset_io_backend()`; a
  white-box runtime test lives beside its std module). Calling a builtin by name without declaring it is
  legal. Other binders of the prefix (`::`, `:=`, parameters) are not rejected yet, apart from `__yo_cell` /
  `__yo_atomic_cell` (`issues/2026-11-21-a-user-binding-named-in-the-yo-namespace-hijacks-or-is-hijacked.md`).
  The rejection goes through `raise_flow_violation`: `yo compile` and `yo test` enforce it, while a plain
  `yo check` whose only error is this one still exits 0.
- `size_of`, `align_of`, `type_of`, `type_id` are the only spellings (`sizeof` etc. were deleted).
- Grammar words (`type`, `trait`, `match`, `fn`, `for`, …), `panic`, `assert`, `imm` are ordinary
  identifiers. `Origin` is a reserved type name like `Type`.
- `___` (discard) cannot be bound twice in one scope (no shadowing). Prefer the bare call `foo();` when
  the result is unused. Keep a discard binding only where it is load-bearing: drop/borrow fixtures that
  count `ref_count(...)` or test the discard's scope-end drop, and compile-error fixtures whose diagnostic
  fires only on the value-evaluation path a binding forces.

## Functions

- `(fn(param1 : Type1, param2 : Type2) -> ReturnType)({ body; return(expr); })` — a normal call: no space
  before `({`, never `(fn(...) -> T) { body }`.
- A function-type alias needs the group: `Callback :: (fn(x : i32) -> i32);`.
- Methods in `impl`: `name : (fn(self : Self) -> ReturnType)({ body })`.
- Use `Self` in method signatures and in `struct(...)`/`enum(...)` definitions: a type's own name is not
  available inside its definition (`Rc(Expr)` inside `Expr :: enum(...)` fails). In a generic type
  constructor `Self` is the current instantiation (`Tree(T)` inside `Tree`); `recur(i32)` there names a
  DIFFERENT instantiation.
- `struct(...)` is the record/effect-record type; `module(...)`, `Module` and `SelfModule` are gone (an
  imported file is a namespace struct; reflect it as `TypeInfo.Struct(...)`; compile-time type parameters
  and results are `Type`).
- **Recursion:** a free function may call itself (and other functions) by name, async ones included
  (`tests/async/fusion.test.yo`). `recur(args)` calls the NEAREST enclosing `fn` with matching argument
  types — inside `io.async((io : Io) => ...)` that is the async lambda, not the outer function. For a
  method, pass the receiver explicitly: `recur(self.left())`.
- **Struct construction takes named fields**: `Point(x : i32(1), y : i32(2))`; positional
  `Point(i32(1), i32(2))` is not supported. Enum variant construction is positional: `.Some(i32(42))`.

```yo
Tree :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    Leaf(value : T),
    Node(left : Rc(Self), right : Rc(Self)) // NOT Rc(Tree(T))
  )
);
```

### Default parameter values (`?=`)

- A `?=` default must be a compile-time-known VALUE: `i32(18)` and a payload-free variant (`.None`, even
  of `Option(Allocator)`) qualify; `Allocator.global()` (a global's address) and `seven()` (a call) do
  not — a runtime-call default is E1105. For a runtime default use `(p : Option(T)) ?= .None` and branch
  in the body; callers pass `.Some(x)` (no implicit `T` → `Option(T)` wrap: E0601).
- Names in a default resolve where the function is defined, not in the caller's module.
- A struct FIELD default follows the same rule: `(root_decl : String) ?= String.new()` is rejected, so a
  `String` or collection field is spelled at every construction site.

### Return-slot modifiers: `comptime` goes on the label; a borrow result is a projection

| Form                                                              | Verdict                                                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `-> comptime(T)` (unlabeled), `-> (comptime(name) : T)` (labeled) | valid                                                                                              |
| `-> &T`, `-> &mut T`, `-> (name : &mut T)`                        | a projection (decision 24): the body yields `&place` / `&mut place` rooted at a borrow parameter   |
| `-> (name : comptime(T))`                                         | rejected — the modifier goes on the label                                                          |

Enforced in `src/evaluator/types/function.yo`; `tests/ref-return-ban.test.yo`. Projections: see
"Borrows" below.

## Return value rules

- The last expression of a block `{ ...; e }` (no `;`) is its value; `{ e }` yields `e`; `{ expr; }` is
  `unit`.
- **`()` is the unit VALUE; `unit` is the TYPE.** Never write `unit;` (it evaluates the type as a comptime
  value). To yield unit, end with `()` or omit the tail. An empty arm is `()` or `{}`; `.{}` is the empty
  RECORD.

## Enums

Variants are defined WITHOUT the `.`; the `.` is for construction and patterns.

```yo
Color :: enum(Red, Green, Blue); // NOT enum(.Red, .Green, .Blue)
Option :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(None, Some(value : T))
);

(c : Color) = .Red;
(x : Option(i32)) = .Some(i32(42));
match(
  c,
  .Red => println(`red`),
  .Green => println(`green`),
  .Blue => println(`blue`)
);
```

- "Failed to infer enum variant type" from a `match`/`cond` arm: qualify the variant (`TypeValue.Unit`).
- In large enum matches, do not bind a pattern variable with the same name as a variant field (prefer
  `struct_field_types` over `field_types`): some codegen paths emit invalid C for that shadowing shape.

### GADT variants

`-> recur(Type1, ...)` after the fields fixes the constructed type; with a discriminant, group the variant:

```yo
Value :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    IntVal(i : i32) -> recur(i32), // constructs Value(i32)
    BoolVal(b : bool) -> recur(bool),
    MGeneric(v : T) // no annotation = unconstrained
  )
);

Tagged :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    (TagInt(i : i32) -> recur(i32)) = 10,
    (TagBool(b : bool) -> recur(bool)) = 20
  )
);
```

## Bindings and mutability

- **Every binding is immutable unless declared `mut(name)`** (decision 47; Rust's `let mut` / `static mut`):
  `mut(x) := v`, `(mut(x) : T) = v`, `(mut(x) : T);`, `mut(x) :: v`, `comptime(mut(x)) := v`,
  `.Some(mut(v))` / `(mut(w) := p)` in a pattern, `{ a, mut(b) }` / `{ x : mut(b) }` / `(mut(a), b)` in a
  destructuring. A write to an unmarked binding is E0917: reassignment (the first assignment of a
  `(x : T);` declared without a value initializes it, per branch), a field or `Array` element write of its
  own storage, `&mut x` (argument, receiver, `y := &mut x`, `match(&mut x, …)`, capture). `(a, b) := expr`
  binds immutable names too: write `(mut(a), b) := expr` to reassign `a`.
- Writes through a door (`r.with_mut(...)` on a `RefCell`) need no marker; reassigning the binding does.
  `String` is a value, so `s.push_str(..)` needs `mut(s)`. A borrow (`x : &mut T`, `y := &mut p`, a `&mut`
  match binding) is written THROUGH, not written; re-pointing a local borrow (`cur = &mut n.next`) is not
  checked by this rule.
- Parameters (and closure parameters, capture entries, `for` element bindings) take no marker: writing one
  is E0917 naming a rebind `mut(p_m) := p;` (no shadowing, so a new name); reassigning one is E0902;
  `mut(x) : T` as a parameter is E0009.
- A malformed marker (`mut(x.f)`) is rejected; a run-time write of a `mut(x) ::` binding is still E0918.
- The marker is recorded by the name's token (`register_mut_binding` / `is_mut_binding`, `src/expr.yo`;
  checks `binding_require_mut` / `place_require_mut`, `src/evaluator/utils.yo`). The rule for bindings
  below module level is not enforced in `src/`, `scripts/`, the root `build.yo`, fetched dependencies and
  macro expansions (`is_global_mut_rule_exempt`, `src/evaluator/memory-safety.yo`). `yo fix <path>` wraps
  one written binding per pass; `YO_AUDIT_MUT_BINDINGS=1` prints every write without rejecting.
- **Module-level runtime bindings:** `mut(G) := v`, `(mut(G) : T) = v`, `thread_local(mut(x)) := v`,
  `(thread_local(mut(x)) : T) = v`. A write to an unmarked global is E0917 (reassignment, a field/element
  write, `&mut G` / `&mut G.f`, a `&mut self` method). Door globals (`RefCell`, `std/sync`) are written
  through without the marker. Lending a `mut(...)` global or a place under it to a call (`f(&G)`,
  `G.get()`, `G == x`, `` `${G}` ``, `for(&G, …)`, `for(&mut G, …)`) is E0916: copy it out
  (`v := G; f(&v)`) and write it back after a `&mut` call. An unmarked global is lent freely except two
  handle conflicts: `&G(i)` when a `&mut self` method is called on `G` anywhere, and `&H.f` when `H.f` is
  written anywhere (lend `&H` and read the field in the callee). A place rooted in a `mut(G)` /
  `thread_local(mut(x))` binding lent to a borrowing future is E0909. `YO_AUDIT_GLOBAL_LEND=1` prints the
  sites without rejecting.
- A collection global the program writes is an unmarked `RefCell(T)` global:
  `(G : RefCell(ArrayList(i32))) = RefCell(ArrayList(i32)).new(ArrayList(i32).new());`, written with
  `G.with_mut(xs => xs.push(x))`, read with `G.with(xs => xs.len())`. Evaluate an argument that reaches `G`
  before the access: any access inside a `with_mut` body of the same cell, and a `with_mut` inside its
  `with` body, panics.
- **Runtime code cannot assign a `::` binding** (E0918): a runtime function, closure or test body writing a
  module-level `::` (`G = v`, `G.x = v`), an enclosing function's `::`, or a runtime value into its own `::`
  local. Every use of the constant was folded. Compile-time writes stay legal (module level,
  `-> comptime(...)` / `-> Type` bodies, CTFE, a `while(comptime(...))` counter, a body's
  `mut(a) :: 1; a = 2;`); an unmarked `a :: 1` is not reassignable (E0917).
- **A compile-time function body declares compile-time locals** (E1104): in a fn returning `-> comptime(T)`,
  `-> Type`, `-> Expr`, … write `x :: v`, `(comptime(x) : T) = v`, `comptime(x) := v` or `comptime(x) : T`,
  never `x := v`, `(x : T) = v`, `x : T` or `y := &mut x`. A runtime fn literal nested inside (a method of
  the returned struct, a closure) and a runtime fn evaluated by `comptime_fn(f)` keep runtime locals.
  `yo fix` applies the rewrite.
- **Module level `::` vs `:=`:** `::` needs a compile-time value. A backtick literal is a runtime `String`,
  so ``NAME :: `…` `` is rejected ("Expected compile-time value"): use a `"..."` `str` constant, or put a big
  backtick blob inside the function that consumes it (precedent: `std/encoding/html-entities.yo`; a
  module-level `:=` global runs at module init and gets an unmangled C name). Conversely a comptime-known
  value bound with `:=` at module level is rejected ("Expected "::" instead of ":=""): untyped
  `arr := [1, 2, 3];` is `Array(comptime_int, N)`, so write `arr :: [1, 2, 3];` or type the elements
  (`arr := [i32(1), i32(2)];`). `Array(T, n).fill(v)` is a runtime value: bind it with `:=`.
- **A tuple TYPE is `Tuple(A, B)`** (`(fn(x : i32) -> Tuple(String, usize))`); `(A, B)` in type position is
  a tuple value holding types ("Cannot store a type value in tuple"). Tuple values are `(a, b)`.

## Parameters and call-site markers

`plans/VALUES_BY_DEFAULT.md` decisions 30, 33, 42.

| Spelling | Means | Notes |
| --- | --- | --- |
| `x : T` | by value: a `Copy` argument is copied, anything else MOVED (the caller's binding ends; a later use is E0901) | the callee owns it (may write, store, return it; drops it otherwise). Copy explicitly with `x.clone()` / `Rc.clone(h)` |
| `sink(x) : T` | by value, always a move | the same type as `x : T` |
| `x : &T`, `self : &Self` | read-only borrow | writing it is E0908 |
| `x : &mut T`, `self : &mut Self` | exclusive borrow | |
| `comptime(x) : &T`, `comptime(x) : &mut T` | compile-time borrow | the binding time wraps the name, the mode prefixes the type; erased at run time |
| `f(&x)` | lends `x` to a `&T` param, a generic one included | to a by-value param: E0914 naming `x` / `x.clone()`; to `*(T)`: naming `addr_of(x)`; to `&mut T`: naming `&mut x` |
| `f(&mut x)`, `f(&mut s.items)` | lends the place to a `&mut T` param | `&mut` is one prefix token; to any other param it is an error |
| `f(x)`, `x` a named place, param `&T`/`&mut T` | E0914 naming `&x` / `&mut x` | required for every type, `Copy` too. Exempt: receivers, temporaries/literals/closures, operator operands, a reference binding passed whole (`f(r)`), `::` constants and function names, ghost code |
| `addr_of(x)` | raw-pointer address-of → `*(T)` | unsafe-capable files only (see "unsafe") |
| `imm(x)`, `mut(x)`, `inout(x)`, `own(x)` as a parameter mode | deleted | E0009 naming `x : &T` / `x : &mut T` / `sink(x)` |

- **The mode is part of the function type for every type**: `fn(x : &i32)` and `fn(x : i32)` differ; an impl
  writes exactly the trait's modes. `Eq`/`Ord` (and `ComptimeEq`/`ComptimeOrd`) take `lhs : &Self, rhs : &Rhs`;
  arithmetic, bitwise and unary traits (and their `Comptime*` twins) take `lhs : Self, rhs : Rhs` /
  `self : Self` by value (decision 34). A by-value `self` has no vtable slot, so `Dyn(LogicalNot)` is E0614.
  Types print `x : T` / `x : &T` / `x : &mut T`.
- A NAMED function value (or a written `(fn(y : i32) -> i32)(…)` literal) fits a function-typed slot only
  with the slot's modes, wherever it goes (E0601 "a parameter's mode is part of the function type"):
  a callback for `f : (fn(e : &E) -> T)` is `(fn(raise : &Raise) -> i32)`; a `Refine(T, p)` predicate is
  `ghost_fn((fn(x : &i32) -> bool)(…))`. A lambda `(lhs, rhs) => …` takes its modes from the expected
  type; an annotated one spells them (`(v : &mut i32) => …`).
- `fn` and `Fn` parameters always need labels: `Fn(s : &String) -> usize`, never `Fn(&String)`.
- `&mut` cannot combine with `sink(...)` or with `generic`/`using` parameters (erased at run time).
- Effect records (`io : Io`, `exn : Exception`, `e : IoExn`) and `Copy` scalars are passed by value, never
  `&`.
- The storing std APIs take their value by value (`push(value : T)`, `insert(key : K, value : V)`, `send`,
  `Mutex.new`).
- A value moved in SOME arms of a `cond`/`match` is dropped at the end of the others (E0907 only for loop
  exits, or when a `match` pattern in the branch binds the same name). An assignment drops an explicit-copy
  old value right after the store (`old := (x = y)` keeps it).
- Compiler-generated source (backtick templates) must spell `self : &Self` where it borrows.

**Choosing a parameter shape:**

| Value | Shape |
| --- | --- |
| read-only struct/enum/primitive | `name : T` (consider `&T` for a large struct) |
| caller's value the callee writes | `name : &mut T` |
| a std collection (`ArrayList`, `HashMap`, `HashSet`, `Deque`, `BTreeMap`, `PriorityQueue`, `OrderedMap`, `HeaderMap`, `StringBuilder`) the callee writes | `name : &mut T` (collections are uniquely owned values; their mutators take `self : &mut Self`) |
| shared `Rc(S)` / `Rc(RefCell(S))` the callee only uses | `name : &Rc(S)`; a callee that keeps the handle takes it by value and the caller passes `Rc.clone(h)` or moves it |
| receiver a method writes / only reads | `self : &mut Self` / `self : &Self` |
| raw FFI pointer | `name : *(T)` (needs `pragma(Pragma.AllowUnsafe);`) |

- Never a raw pointer where a borrow will do: `ctx : &mut EvalContext`, not `ctx : *(EvalContext)`; pass
  `&obj` / `&mut obj`, never `addr_of(obj)`.
- Trait declarations follow the dominant impl: a method that writes its receiver (`Hasher.write*`,
  `Iterator.next`, `Index`/`IndexMut`, `ComptimeIndex`, `log.Sink.write_line`) takes `self : &mut Self`; one
  that only reads it takes `self : &Self`, as in Rust: `Clone.clone`, `Display.fmt`, `Hash.hash`,
  `Hasher.finish`, `Debug.debug_fmt`, `Format.format`, `ToJson.to_json`, `Error.source`, `Reader`,
  `Writer`.
- `YO_AUDIT_INOUT_BORROW=1 yo check <path>` lists writes through a borrowed copy.

### Two-phase argument rules (decision 28, E0910)

- A later argument may not move, assign to, or lend `&mut` a place an earlier argument lends:
  `f(&mut a, eat(a))`, `f(&a, { k := eat(a); k })`, `a.peek(eat(a))`, `a == make(eat(a))`,
  `peek(&p.s, { p = q; k })`, `peek(&p.s, reset(&mut p))` are errors. A read or `&` relend later is fine
  (`xs.push(xs.len())`), as is a write to a disjoint field. Move a copy (`eat(a.clone())`) or compute the
  later argument first (`k := reset(&mut p); peek(&p.s, k)`).
- Two lends of one call may not overlap when one is `&mut` and both are rooted at the same value local
  (either order): `s.push_string(&s)`, `f(&mut p, &p.name)`, `f(&mut p.name, &p)` — copy one side first
  (`t := s.clone(); s.push_string(&t)`). Two `&` lends and disjoint fields pass; an `Rc` root is not a value
  root (`_check_call_value_root_overlap`, `src/evaluator/calls/function.yo`).

### `&mut` parameters

```yo
swap :: (fn(a : &mut i32, b : &mut i32) -> unit)({
  tmp := a.*;
  a.* = b.*;
  b.* = tmp;
});

main :: (fn() -> unit)({
  mut(x) := i32(1);
  mut(y) := i32(2);
  swap(&mut x, &mut y); // the call site lends each place with `&mut`
  assert(x == i32(2), "swapped");
});
```

- Inside the callee the parameter is a reference binding: the whole value is `a.*` (read and write);
  receivers, fields and indexing stay bare (`a.f`, `a.m()`, `a(i)`). See "Reference bindings".
- Pass a reference binding on to another reference parameter bare: `inner(x)`, or `inner(&mut x.*)`.
  `inner(&mut x)` lends the reference itself (`&mut &mut T`) and is E0601.
- `comptime(name) : &mut T` mutates a compile-time binding (the prelude's `ComptimeIndex` uses it); zero
  codegen impact.

## Borrows

### Reference bindings: `.*` is the deref (E0926)

`.*` on a reference binding (`v : &T` / `&mut T` parameter, `y := &x`, a `for(&xs, x => …)` element, a
`match(&x, …)` binding, a reference field `v.f`) is the reference's own deref:

- A whole-value read or write of the referent is `v.*` / `v.* = e`. The bare name in a by-value position
  (an operand, a by-value argument, an initializer, a return, `v = e`) is E0926.
- Bare stays legal for: receivers (`v.f`, `v.m()`, `v(i)`), `f(v)` into a reference parameter, the
  re-point `v = &place`, and a `match(v, …)` scrutinee (it matches through the reference; bindings borrow
  the payload). `match(&v, …)` on a reference is E0926.
- Through a reference to a `Box`/`Rc`/pointer the payload is `v.*.*`. Reading a reference field is
  `v.at.*`; `v.at = &place` (or a reference binding) re-points it, checked as the whole-holder store
  `v = H(at : &place, …)` is, and `v.at = value` is E0926. `&mut v.at` on a `&` field lends the field itself
  (a `&mut &T`); on a `&mut` field it still lends the place it refers to.
- An `io.async` capture of a reference parameter borrows it whole as `{ p : &p.* }` (`{ &p }` is E0926); a
  by-value capture entry `{ r }` of a reference binding copies the reference (`{ r : r.* }` copies the
  referent).
- An assignment's operator RHS stays grouped: `r.* = (a + b)`.

### Local borrows (decision 18)

- `y := &mut x;` names x's slot (`y.* = v` writes x; `c := y.*` copies); `y := &x;` (or `(y : &T) = &x;`) is
  read-only — writing through it, passing it to `&mut`, a writing method or `z := &mut y.f` is E0908.
- **Live until LAST USE, and it freezes its place** (E0911): under `&` no write/move of the place, a place
  inside it or one containing it; under `&mut` no access except through the borrow. Sibling fields are free
  (`a := &mut p.x; b := &mut p.y;`); below an `Rc`/`Arc` the CELL is the unit; a loop that mentions the
  borrow keeps it live for the whole loop; a borrow of a borrow keeps its source live; a borrow of a
  module-level place may not be live across a call, and one through a cell or module-level place not across
  an `await`.
- **Accepted places:** a whole variable, a field path rooted at a value struct, a field path through an
  `Rc`/`Arc` handle (`h.n`; the innermost object is pinned for the binding's scope). **Rejected:** element
  places (`xs(i)`, `p.*` — iterate with `for(&coll, …)` or read in place with `match(&xs(i), …)`), rvalues,
  `Type.member`, compile-time roots, `::`, module-level declarations, and moving the root while the borrow
  lives.
- **Re-point** with `cur = &mut place` / `cur = &place` (decision 25): the place is a field of `cur`'s
  target, a field of a binding of a bare `match` over `cur`
  (`match(cur, .Some(n) => { cur = &mut n.next; }, .None => ())`; a unique `Box` on the way is a free step,
  so the mutable list is `Option(Box(Node))`; an `Rc` list walks only with `&`, E0919), or a place of another
  variable (`cur = &mut other.f`, a new loan: `mut(other)` for `&mut`; `cur` used after `other`'s scope is
  E0911). Rejected: a call result, an index, a `.*` step, a binding of a by-value `match(cur.*, …)`. `n` is
  frozen after `cur = &mut n.next`; a re-point is E0911 while a borrow derived from `cur` lives.
- **A local borrow never crosses the function boundary** (E0912): `return(y)`, `return(y.f)`, or a body
  result that is the borrow. Copy out (`v := y.*; v`); `y.len()`, `xs(i)` and operations produce values and
  are fine.
- Inside an `io.async` body a borrow works across awaits (reference, pin and root live in task slots).
- A `&mut` ARGUMENT is a simple place: a variable or `var.field` rooted at a local/param; bind
  intermediate handles to a local first.

### Projections (`-> &T` / `-> &mut T`, decision 24)

- The body yields a place written with the result's sigil (`&self.a`, `&mut self.rows(i)`; every
  `cond`/`match` arm and `return(...)` likewise) or a reference binding (`x` for `x : &T`; `&x.*` stays
  legal; a field read or projection call is not a bare leaf: `&h.r.*`, `&r.get()`), rooted at one of the
  projection's borrow parameters (a `&mut` result needs a `&mut` parameter). Its `&T` parameters are passed
  by pointer.
- Reached through the subscript (`x(i)`: `Index.index` reads, `IndexMut.index_mut` writes) or a direct
  call by name (`t.index(i)`, `Trio.index(&t, i)`, `first(&t)`; not through a function value).
- A direct call's result is the PLACE: an operand (`t.index(i) + 1`), a receiver
  (`n.name_mut(0).push_str("!")`), a bare argument to a reference parameter (`f(t.index(i))`), a local
  borrow (`r := t.index(i)`, freezing the borrowed arguments until its last use, E0911; `(v : T) = t.index(i)`
  copies), and for `&mut` the left of `=` (`t.index_mut(i) = v`). A `&` projection's place is read-only
  (E0908). A projection call whose borrowed argument is a temporary cannot be bound. A projection may yield
  another's result (`&g.index(i).a`) rooted at its own parameters (`docs/en-US/TRAITS.md`).

### Origins (decision 43)

- A parameter may spell its reference's origin: `x : &(T, p)` / `x : &mut(T, p)` with `generic(p : Origin)`
  (a union is `&(T, (p, q))`). Same function type and C as `x : &T`; an origin binder does not make the
  function generic. A non-origin second argument (a type, an undeclared name, another parameter) is an uncoded error
  (a reference to a tuple is `&Tuple(A, B)`).
- A projection's result may spell its origin: `-> &(T, p)`, `-> &(T, xs)` (the reference parameter `xs`), a
  union `-> &(T, (p, xs))`; a by-value parameter there is E0912. A call freezes only the arguments the
  result origin names (elided = every reference parameter; an E0911 conflict on an elided call names the
  `-> &(T, keep)` spelling). A body yielding a place from a parameter the origin does not name is E0923
  (from a local or by-value parameter E0912); an impl's result origin must lie within its trait method's
  (E0923); a `Dyn` call uses the trait's origin. A reference-returning method with a callback slot spells
  its origin (`OnceCell.get_or_init : (fn(self : &Self, f : &mut Impl(FnMut() -> T)) -> &(T, self))`).
- `Fn(s : &T) -> &U` is a closure trait returning a reference (origin per call, never spelled; `-> &(U, o)`
  there is an error): filled by a named projection or a closure yielding `&place` from its own parameters
  (a captured place is E0923). A projection is callable through a `fn(...) -> &T` value, an
  `Impl`/`Dyn(Fn(...) -> &T)` and a `ctl(...) -> &T` operation, whose handler resumes with
  `return(&place)`.
- Outside a parameter slot `&T` / `&(T, o)` is a reference TYPE: a field, a type argument
  (`Option(&(i32, x))`), an alias. A type constructor takes `comptime(p) : Origin` and is applied to an
  origin by name (`View(x)` with `x` a local, parameter or module-level binding; an origin parameter; a
  union `(x, y)`). A field naming its own type's fields (`&(i32, self.value)`) is E0924; an `extern`
  signature or module-level binding whose type carries an origin is E0909. Origins are erased from identity
  (`View(x)` and `View(y)` are one C type).
- INLINE COMPOSITES over reference types have values: a value struct/enum (`Option(&mut i32).None`), a
  tuple, an array. A constructor call lends each reference field's place (`at : &x`), freezing the lent roots
  (E0911); returning one whose origin names a local is E0912. A `&T` field is `Copy`; a `&mut T` field makes
  the holder move-only unless it derives `Copy, Clone`. A reference inside a container or cell
  (`ArrayList(&T)`, `Rc`, `RefCell`) is an error naming N2c/N2d.

## Values: moves, `Copy`, `Clone`, `Drop`

### Move-only and explicit-copy values

- A plain-data type WITHOUT `Copy` is copied only explicitly: `q := p` moves it (a later `p` is E0901, whose
  note names `derive(T, Copy, Clone)`). `String`, the collections and `Rc`/`Arc` handles are explicit-copy
  too (`s.clone()`, `xs.clone()`, `Rc.clone(h)`). A `&T` parameter or `match`/`for` binding of such a value
  borrows, so storing or returning it is E0901: take the parameter by value.
- A value type with `Drop`, or one that is neither `Copy` nor `Clone` (decision 36), is MOVE-ONLY, as is any
  aggregate holding one (`Option(Fd)`, `Tuple(Fd, i32)`, a field, a closure capture). Every copy point
  moves it (`:=`, `=`, `sink`, a field/element store, a constructor argument, a return, a capture). It
  cannot be copied out of a `&T` parameter or `match`/`for` binding, a `&mut` borrow, a module-level
  binding, a field (`h.fd`: no partial moves — `std/mem`'s `take(&mut h.fd)` / `replace(&mut h.fd, v)`) or a
  dereference. Lend it (`f(&fd)`).
- To split an OWNED holder, match it with a struct pattern: `match(e, { key : _, value : v } => v)` moves
  `v` out and drops `key` (`{ a, b } := e` only borrows).
- Unsafe container code moves a slot bitwise: `__yo_ptr_read(p)` takes the value out, `__yo_ptr_write(p, v)`
  puts one in without dropping the old bits; compare in place (`p.*.key == key`) rather than binding `p.*`.
- A shared cell (`Rc`, `Arc`) is never move-only. `Drop` on a primitive, tuple or pointer is rejected at
  the `impl`.
- A recursive enum with `Box(Self)` children is move-only even with `Clone`. `xs.get(i)` of such an element
  is E0901: read it in place with `xs(i)`, copy with `xs.get_cloned(i)` / `xs(i).clone()`, write with
  `xs.with(i, …)`, lend with `f(&xs(i))`, walk with `for(&xs, …)` / `for(&mut xs, …)`, own with
  `pop`/`remove`. A local element borrow `e := &xs(i)` is rejected: match in place with
  `match(&xs(i), …)` (bindings borrow, nothing is copied). `match(&mut xs(i), …)` is rejected (a temporary).
- `YO_FLIP_REPORT=1 yo check <path>` prints each plain-data type that is explicit-copy (`[flip] <type>`)
  once, so one pass names every type that still needs a derive.

### `Copy` (decision 36)

- `Copy :: trait(id := "Copy", where(Self <: Clone))` requires `Clone`. Integers, floats, `bool`, `char`, the
  C number types, `unit`, `str` and `*(T)` are `Copy`; `Option(T)`/`Result(T, E)` under `where(T <: Copy)`.
- Opt in with `derive(T, Copy, Clone)` (also for function-local types), or `impl(T, Copy())` beside a
  `Clone` impl. Generic: `derive(generic(T : Type), where(T <: Clone), Pair(T), Clone)` plus
  `derive(generic(T : Type), where(T <: Copy), Pair(T), Copy)`. `derive(T, Copy)` alone is an error naming
  the pair; the compiler never writes a `Clone` impl. `where(T <: Copy)` gives `T <: Clone`.
- The impl is checked: a `Clone` impl covers it, every field/payload is `Copy` (the error names the first
  that is not), no `Drop` (either order), never a reference type. Tuples, arrays, closures, anonymous
  records and `fn` pointers cannot declare it: they are `Copy`/`Clone` exactly when all parts are
  (`Type.impls(Tuple(i32, bool), Copy)`; the prelude has tuple `Clone` impls for arities 1–12; `.clone()` on
  a `Copy` record/closure/fn pointer is the copy, on a `Clone`-not-`Copy` one it clones field-wise).
- A CLOSURE's parts are its capture record: a by-value capture (listed, or implicit — a closure bound to a
  name owns what it captures) counts with its type, a `&` capture is `Copy`, a `&mut` capture makes it
  neither `Copy` nor `Clone`. A non-`Copy` closure is explicit-copy: `d := c` moves `c` (E0901 names
  `c.clone()`); `where(T <: Copy)` rejects it (E0602).
- `derive(T, Clone)` is always allowed. A HAND-WRITTEN `Clone` is an error only where every instantiation it
  serves is `Copy`.
- A raw pointer's `p.clone()` copies the pointer: `p.m(...)` is always the pointer's own member, and a
  pointee member is `p.*.m(...)` (a pointee field read as `p.f` is E0623).
- Exempt from the explicit-copy rule: compile-time-only types, control-bound records (`Exception`, effect
  records), unions, C opaque types, refinements of a `Copy` type, types still mentioning a type variable
  (judged per instantiation).
- Iterator consumers/adapters take `sink(self)`.

### `Drop` (decision 45)

- `impl(T, Drop(drop : (fn(self : &mut Self) -> unit)(...)))` — Rust's receiver: the destructor may take a
  field out (`self.f = .None`); fields drop after it returns. `self : &Self` does not conform. `Dispose` is
  not recognized.
- **Never call the destructor by hand**: `x.drop()`, `T.drop(&x)`, `(T <: Drop).drop(&x)` are E0915. A
  destructor never calls a field's destructor.
- End a value early with the prelude's `drop(x)` (moves `x`). A resource released while other references
  live gets an inherent method its destructor delegates to (`TcpStream.close_sync()`).
- `drop_in_place(p)` (prelude, `p : *(T)`, unsafe): see "unsafe".

### `Rc` / `Arc` handles

- **Shared data** is an `Rc(S)` (payload read-only, E0919) or an `Rc(RefCell(S))` written through the door.
  There are no user-declared reference-semantics types (`ref(...)` / `atomic(...)` are E0009). Raw `*(T)` is
  for FFI.
- **A second handle is `h.clone()` / `Rc.clone(h)` / `Arc.clone(h)`** (decision 17): a count bump, no bound
  on `T`. `h.clone()` on a handle is always the handle's own `clone`, in a generic body too; `h.*.clone()` is
  the payload's. A handle's last use moves it; a copy whose source is used again,
  or any copy out of a borrow, a field or a module-level binding (`return(h)` of a `&Rc(T)` parameter,
  `n.label`), is E0901 (its help names `Rc.clone(h)`). A value holding a handle is explicit-copy too
  (`x.clone()`, derive `Clone`). A deep copy is `Rc.new(h.*.clone())`. `&Rc(T)` parameters borrow without a
  copy.
- **`.` never reads through a handle** (`Deref`): `x.name` is a member of `x`'s own type, read through any
  number of `&`/`&mut` (`r.x`, `r.m()`, `r(i)` on `r : &T` stay bare). `x.*` is the only dereference (a
  reference's referent, a raw pointer's pointee, a `Box`/`Rc`/`Arc` payload, an owner's view); `Deref` and
  `DerefMut` define `.*` and nothing else. A payload member takes one star per layer: `b.*.x`, `b.*.m()`,
  `b.*.items.push(v)` on a `Box(P)`, `bb.*.*.x` on `Rc(Rc(P))`, `h.*.items(i)` / `h.*.f(x)` in callee
  position, `a.*.with_lock(v => …)` on `Arc(Mutex(T))`, `d.*.area()` on `Box(Dyn(Area))`, `q.*.x` on a raw
  pointer. A reference to a handle takes two stars: `x : &Box(Node)` (a `for(&xs, x => …)` element, a
  `match(&self.next, .Some(b) => …)` binding) reads `x.*.*.value`; the idiomatic forms are the `Box(n)`
  pattern (`.Some(Box(n)) => n.total()`) and `x.as_ref().value`.
- **`b.x` with `.` alone is E0623** (`E_MEMBER_BEHIND_DEREF`): its help spells the full chain and its
  `yo fix` repair inserts the stars. `r(i)` on a handle is E0606 naming `r.*(i)`; `for(&r, …)` over a handle
  is E0623 naming `for(&r.*, …)`. Operators and parameters never dereference (`r.* + 1`, `takes(&r.*)`). In
  a safe file a write through an `Arc` is still rejected (`a.*.n = v`, a `&mut self` method).
- **Writes through an `Rc` payload are E0919** (decision 46): `h.*.push(x)`, `h.*(i).f = v`,
  `addr_of(h.*(i))`. Use `Rc.make_mut(&mut h).push(x)` (payload `Clone`) or an `Rc(RefCell(...))`.
- **`Deref` owners** (VERDICTS-63): `Deref` carries `deref : fn(self : &Self) -> &Self.Target`, `DerefMut`
  carries `deref_mut`, chosen like `Index`/`IndexMut` (a write, a `&mut` lend, a `&mut self` receiver and
  `addr_of` call `deref_mut`). `Box`/`Rc`/`Arc` are handles whose `.*` is native; any other `Deref` type is
  an owner (`Array(T, N)` with `Target : [T]`, a user type over `[T]`) whose `x.*` is its projection:
  `v := &x.*` binds `x.deref()`, `w := &mut x.*` binds `x.deref_mut()`. `x.m()` is the owner's own member and `x.*.m()` reaches the view's (`a.is_empty()` on an array is E0623). Nothing derefs at a parameter:
  pass `f(&s.*)`, never `f(&s)` (E0601 naming `&s.*`). Outside the prelude a `Deref` impl needs an unsized
  `Target` (`[T]`, `str`, a `Dyn`), else E0622. `ArrayList(T)` is an owner too (`Target : [T]`, with
  `DerefMut`): `&list.*` is a `&[T]`, and `list.*.m()` calls a `[T]` method on the elements. `String` does
  not implement `Deref`.
- A generic impl's `where` is not consulted when its method is resolved
  (`issues/2026-10-20-rc-clone-of-a-non-clone-payload-fails-inside-the-prelude.md`).

## `match`

### How a `match` takes its scrutinee (decision 26)

- **Bare scrutinee of a non-`Copy` type** (owned local, by-value parameter, temporary): MOVED into the
  match. The chosen arm's bindings own their parts; parts the arm does not bind are dropped when it is
  entered; guards see bindings as borrows. Below an `Rc` payload bindings borrow. A later use of the
  scrutinee is E0901 naming `match(&x, …)`.
- **`match(&x, …)`**: read-only borrows; each binding is a reference into `x`'s place (freezing `x` while
  live, E0911). `&temp` borrows a temporary held in a C local.
- **`match(&mut x, …)`** or a bare `&mut` binding scrutinee: bindings are `mut` PLACES (`v = …` writes the
  part, dropping the old value). While a binding lives, `x` is reached only through it;
  `cur = &mut n.next` is the one statement that may name `cur`. `&mut` of a `&` binding is E0908, of a
  temporary an error. Bindings below a cell stay copies. A place lives across an `await` unless its scrutinee passes through a cell or a
  module-level place (E0911).
- **A `Copy` value**: copied.
- **E0901 naming the borrow:** a by-value match of a module-level binding, a closure capture, a field
  `x.f`, an element `xs(i)` or a dereference `p.*` of a non-`Copy` type — write `match(&x.f, …)`.
  `(name := p)` in a consuming match needs `Copy` sub-bindings (none in a `mut` match); an or-pattern of a
  consuming match may not leave a part with a drop unbound (split the arm).
- The desugar peels the marker and records it (`borrowed_match_scrutinee_kind`).

### Pattern forms

Patterns compile to a pattern IR (`src/pattern.yo`, `plans/reference/MATCH_PATTERN_MATCHING.md`). Every
infix pattern needs its own parentheses.

| form | example | meaning |
| --- | --- | --- |
| `_` | `_ => …` | wildcard |
| identifier | `other => (other + 1)` | binds — unless it names a `::` constant holding a literal or enum value, which is COMPARED (`TEN => …`) |
| constant | `0`, `-1`, `true`, `'a'`, `"lit"`, `i32(5)`, `Color.Red` | compared with `==`; a `str` literal matches a `String` or `str` |
| variant | `.V`, `.V(p, q)`, `.V(label : p)`, `.V({ a, b : p })`, `.V(..)` | `.V` only for a variant without fields; `.V(..)` = any payload; sub-patterns at any depth: `.Ok(.Some(v))`, `.Of((48..=57))` |
| or | `(.Red \| .Green) => …`, `.Some((.A \| .B))` | alternatives bind the same names |
| range | `(0..10) => …`, `(10..=19) => …` | compile-time bounds |
| whole-value binding | `(whole := .Some(v)) => …` | binds the value AND matches |
| guard | `(.Some(v) && (v > i32(100))) => …` | runs when the pattern matches and the guard is true |
| struct | `Point(x : 0, y)`, `{ x, y }` (struct scrutinee) | bare names bind, unlisted fields match anything |
| tuple | `(a, b)` | exact arity |
| wrapper | `Rc(p)`, `Arc(p)`, `Box(p)`, `(c := Rc(p))` | looks through the cell; `Rc(x)` binds the payload (a borrow), `(c := Rc(p))` the cell |

```yo
Shape :: enum(
  Circle(radius : i32),
  Rectangle(width : i32, height : i32),
  Triangle(base : i32, height : i32, label : str)
);

area :: (fn(s : Shape) -> i32)(
  match(
    s,
    .Triangle({ base, height : h }) => (base * h), // preferred: curly, order-free, partial
    .Circle(radius : r) => (r * r), // labeled pairs: also fine
    .Rectangle(w, h) => (w * h) // positional: only for one- or two-field variants
  )
);
```

- **Prefer the curly form** `.Variant({ field1, field2 : alias })`: adding a field never shifts positions.
  `{ a }` binds `a`; `{ a : x }` renames; `{ a : _ }` asserts the field and ignores it; partial lists are
  fine; a bare `{ _ }` is rejected (`tests/match-curly.test.yo`).
- **A variant pattern has parentheses exactly when the variant has fields** (VERDICTS-88): `.Empty`;
  `.Rect(w, h)` / `.Rect(w : p)` / `.Rect({ w })`; `.Rect(..)` matches any payload and binds nothing (`..`
  written alone). A bare `.Rect` on a variant with fields, `.Rect()`, `.Rect({})` and `.Empty(..)` /
  `.Empty()` / `.Empty(_)` are E0626, a wrong positional count too; `yo fix` writes `.Rect(..)` or deletes
  the group. `..` anywhere else is E0609 (positional: one `_` per skipped element; labeled or struct:
  delete it) (`tests/match-bind-nothing.test.yo`).
- **`src/`, `std/` and seed-run test files write `.V(_, _)`, not `.V(..)`, until `SEED_VERSION` is
  v0.2.81**: the v0.2.80 seed rejects `.Rect(..)` and reads `.Circle(..)` as a binding named `..`.
- In a VARIANT payload, a nested struct sub-pattern uses the NAMED form: `.Holding(Outer(inner : { a, b }, tag))`;
  `.Holding({ inner : { a, b } })` is E0406 (its labels are read against the variant). Otherwise nesting is
  free: `.Foo({ a : .Some(x) })`, `.V((0, y))`, `.V(Point(x : 0, y))`.
- An `Rc(T)`/`Arc(T)` position takes ONLY the wrapper spelling (decision 31): `.Cons(h, .Cons(n, _))` through
  `tail : Rc(Self)` is E0609 naming `Rc(p)`; write `.Cons(h, Rc(.Cons(n, _)))`. A bare binding there binds the
  cell. A `Box` position is also looked through implicitly.
- **Exhaustiveness is structural** (E0607): `.Some(true), .None` reports `Missing case: .Some(false)`; a
  guarded arm never covers. Integer constants and ranges are intervals of the fixed-width type (`(0..=255)`
  covers `u8`; gaps print as ranges). `usize`/`isize`, floats and strings need a `_` or binding arm.
- **An arm that can never run is E0608**: a duplicate variant/literal, any arm after a catch-all, a range
  inside an earlier one, `(1 | 1)`, an empty range `(5..5)`, a GADT variant the scrutinee excludes. An arm
  the earlier arms cover only TOGETHER is a warning. Invalid pattern: E0609.
- Every form works in an `io.async` arm that awaits, and `io.await(...)` may appear anywhere in an arm
  (`tests/match-async-arms.test.yo`).

### `match` pitfalls

- Never lend a match binding `&mut` when the arm can drop the last reference to its cell: `f(&mut n)` plants
  a borrow assert on the cell, and unlinking first frees it (ASan heap-use-after-free; the shape of a doubly
  linked `pop_front`). Read/write the fields you need BEFORE the assignments that drop handles.
- `Option(&T).unwrap()` cannot reach the payload's methods yet (E0601 inside `unwrap`;
  `issues/2026-11-05-an-option-of-a-reference-cannot-reach-its-payloads-methods.md`). Use a `match`:
  `match(h.get(), .Some(p) => p.len(), .None => usize(0))` (the binding is a reference binding, and `.`
  reads through it).

## Loops

### `while`

- No `loop` function: `while(true, body)` is the infinite loop.
- `while(cond, body)` is always a run-time loop and its condition always a run-time expression: never
  `while(runtime(cond), …)`.
- `while(comptime(cond), body)` opts into compile-time unrolling; `cond` must be compile-time known, and an
  evident infinite loop (`while(comptime(true), ...)` with no `break`/`return`/`unwind`) is an error.
- A comptime-only (`::`) variable in a bare `while` condition is an error (it could never change).

### `for(coll, x => body)`

`for` is desugared at parse time (`_desugar_for_call`, `src/expr.yo`) into a `while` over `.into_iter()`; a
user function named `for` is never called by it.

```yo
for(list, x => {
  process(x);
}); // value form: consumes list
for(&mut names, s => {
  s.push_str("!");
}); // borrowed form: writes in place
for(chain.map(f), y => println(&y)); // an iterator chain as the source
```

- **Value form `for(coll, x => …)`**: `coll.into_iter()` (`self : Self`), so it CONSUMES `coll` (a later use
  is E0901: use the read walk or `coll.clone()`). `chars`/`bytes`/`char_indices`/`lines`/`keys`/`values`/
  `chunks`/`windows` consume their receiver too. `iter()` yields raw pointers (unsafe-capable code only).
- **Borrowed form `for(&mut coll, x => …)`** (decision 39): the value form over `(&mut coll).into_iter()`,
  whose cursor (`ArrayListIterMut(T, p)`, …) holds the `&mut(C, p)` lend; `x` is a `&mut(T, p)` item
  (`x.* = …`; struct fields write in place). The hidden iterator carries the `for` position
  (`for_desugar_site_of`), so the body may NOT name `coll` at all (E0911, Rust's `iter_mut` rule). `x` is
  second-class (`return(x)` is E0912; `v := x.*`). To read or grow a list while walking it, walk positions:
  `for(xs.indices(), i => …)` with `xs(i)`. A non-place source is held by a hidden local; behind an `Rc` lend
  the payload: `for(&xs.*, …)`. Maps: `for(&mut m, (k, v) => …)` (key read-only; a single name binds the
  tuple). `HashSet`/`PriorityQueue` have no `&mut` form. A `mut(G)` global source is E0911.
- **Read walk `for(&coll, x => …)`**: over `(&coll).into_iter()`, each element a `&(T, p)` reference,
  nothing copied. `x.* = …` / `x.f = …` are E0908; the body may read `coll` but not write it (E0911).
  `return(x)` is E0912. Maps: `for(&map, (k, v) => …)`. Every std collection is a read-walk source. Works in
  an `io.async` body with awaits in the loop.
- A user type is a source by `impl(generic(p : Origin), &(C, p), IntoIterator(Item : &(T, p), IntoIter : MyCursor(p), …))`
  over a cursor struct holding `&(C, p)`.
- `for(x, arr, { body })` (3 arguments) is not valid source.
- **Async iteration is the written-out loop** (`std/async/stream.yo`):
  `mut(s) := stream; while(true, { n := io.await(s.next(io), io); match(n, .Some(x) => body, .None => { break; }) });`.
  An `io.await` inside a function the task calls BLOCKS instead of suspending, so there is no named loop
  form.

## Indexing: `xs(i)`

`ArrayList(T)` implements `Index`/`IndexMut` (projections, `self : &Self` / `&mut Self` → `&Output`):

```yo ignore
val := list(usize(0));    // read (panics out of bounds)
list(usize(0)) = i32(99); // write in place
o := list.get(usize(0));  // Option(T): a bounds-checked copy (E0901 for a non-Copy element: use get_cloned)
```

Prefer `xs(i)` / `xs(i) = v` over spelling `.index(i)` / `.index_mut(i)` or `addr_of(xs(i))`; keep
`addr_of(xs(i))` (unsafe-capable code) only when the raw `*(T)` itself is needed.

## Closures and function values

### `=>` closures vs `fn` literals

- A `=>` closure infers parameter types from the expected `Fn(...)` signature. A `: Type` on a parameter is
  documentation only (the adopted signature wins; a mismatch is not diagnosed); it is the idiom in
  `io.async((io : Io) => ...)`.
- Use the full `fn(...)` form for a standalone signature:

```yo
pred :: (fn(x : &i32) -> bool)(x.* > i32(2));

main :: (fn() -> unit)({
  a := (i32(0) .. i32(5)).filter(x => (x.* > i32(2))); // inferred
  b := (i32(0) .. i32(5)).filter((x : &i32) => (x.* > i32(2))); // annotated
  c := (i32(0) .. i32(5)).filter(pred); // named fn
});
```

- **Nested `=>` needs a right group**: `(x : i32) => (y : i32) => ((x + y))` is a same-operator chain and
  parses as `((x) => (y)) => …` (an "Expected a function type" error later). Write
  `(x : i32) => ((y : i32) => ((x + y)))`.
- **Binding a closure to a local needs the expected type** and parentheses:
  `(cb : Impl(Fn(x : i32) -> i32)) = (x => (x + base));`; `cb := (x => ...)` fails with "Expected a function
  type, got: …".
- **A `fn` literal does NOT capture**: naming an enclosing local inside `(fn(...) -> T)(body)` is E0401
  `Variable "m" not found` at the use. Pass the value in as a parameter, or use a `=>` closure.
- **Closures capture BY VALUE**: an implicit capture copies a `Copy` value (an `i32` counter mutated inside
  never comes back out) and moves anything else. To share state, capture a second handle:

```yo
{ ArrayList } :: import("std/collections/array-list");
{ RefCell } :: import("std/sync/refcell");

main :: (fn() -> unit)({
  calls := Rc.new(RefCell(ArrayList(i32)).new(ArrayList(i32).new()));
  (f : Impl(Fn() -> i32)) = ({ c : Rc.clone(calls) }() => {
    c.with_mut(xs => xs.push(i32(1)));
    i32(7)
  });
  f();
});
```

- **Result-type inference:** when an argument's return type must be inferred into a type variable
  (`o.map((x) -> ...)`, any `Impl(Fn(..) -> R)` / `where(F <: (Fn(..) -> R))` parameter), a capture-free `->`
  literal and a `=>` closure both bind `R`; pick `=>` only to capture. `->` stays required for effect
  handlers (their result is the per-call-site `ResumeType`).
- A closure's body is checked against the `Fn(...) -> R` it adopts (E0604). A `comptime(x) : T` parameter
  needs a compile-time argument (E1101).

### Capture lists: `{ x, &y, z : &mut w }(params) => body` (decisions 35, 38)

- `x` / `x : e` — by value (copy, or move). `&y` / `name : &place` — read-only borrow; `&mut z` /
  `name : &mut place` — writing borrow (the puns stand for `y : &y`, `z : &mut z`).
- The list is EXHAUSTIVE: the body reads only listed names and module-level items (`{}()` captures
  nothing).
- A borrow names a place rooted at a local: no temporary, no module-level binding, nothing through an
  `Rc`/`Arc` or `p.*` (capture the handle and re-derive); a `&mut` place must be writable.
- Captured borrows are reference bindings: read and write them with `.*`.
- A borrowing closure is SECOND-CLASS (E0909): bind it, call it, pass it to a plain parameter — never return,
  store, `dyn`, `sink`, capture in `io.async`, or name it in a type argument. A `&mut` capture makes it
  move-only; `&` captures keep it `Copy`. A non-`Copy` by-value capture makes it explicit-copy. Its places
  are frozen until the binding's scope ends (E0910): wrap the closure and its calls in a `{ …; }` block to
  use the place afterwards.
- `&f` to an `f : &Impl(Fn(...))` parameter lends the closure; to a by-value one it is an error naming `f`
  (a closure argument always moves). Passing a closure bare, `apply(f, 1)`, is legal.
- A capture list on an `io.async` body is not supported yet.

```yo
main :: (fn() -> unit)({
  mut(total) := i32(0);
  (i32(1) .. i32(4)).for_each({ &mut total }(x : i32) => {
    total.* = (total.* + x);
  });
  k := i32(1);
  w := i32(2);
  (h : Impl(Fn(m : i32) -> i32)) = ({ k, &w }(m : i32) => (m + k + w.*));
});
```

### `Fn`, `FnMut`, `FnOnce` (decision 37)

`Fn` implies `FnMut` implies `FnOnce`: an `Fn` closure fills any slot, an `FnMut` one an `FnMut`/`FnOnce`
slot. A value typed `FnMut` at an `Fn(...)` slot or boxed as `Dyn(Fn(...))`, or `FnOnce` at an `Fn`/`FnMut`
slot, is E0913. A closure literal takes the trait of its slot.

**`FnOnce`** — call-once:

- A call consumes the closure: a second call or later use is E0901 pointing at the first call.
- Only capture-list BY-VALUE entries are owned by the body: it may move one out (a `sink` argument, a
  binding, the tail); the rest drop when the call ends. Moving out of an implicit capture, or of any capture
  in an `Fn` closure, is E0913.
- Call it from an API it escapes into: `sink(f) : Impl(FnOnce(...))`. Calling through a borrowed
  `f : Impl(FnOnce(...))` is E0901. A `sink` closure called on one `cond`/`match` arm is dropped uncalled at
  the end of the others; ways out of a loop must agree (E0907). A generic callee may call its own `FnOnce`
  parameter once.
- `io.async` takes `Impl(FnOnce(e : E) -> T)`. Run-once std bodies take `sink(body) : Impl(FnOnce(...))`
  (`RefCell.with_mut`, `HashMap.entry`, `ArrayList.with`, `Deque.with`), so the body may move its captures:
  `cell.with_mut({ t }(xs) => xs.push(t))`.

**`FnMut`** — call repeatedly with state:

- A call borrows the closure exclusively. Its body may write its BY-VALUE capture entries (state kept
  across calls) and its `&mut` captures:
  `(mut(tick) : Impl(FnMut() -> i32)) = ({ n : i32(0) }() => { n = (n + i32(1)); n });`. Under
  `Fn`/`FnOnce` an entry write is E0917. Storing a reference to the call's parameter into the state is
  E0923, to a body local or another by-value entry E0912; a borrow capture
  (`{ o : &x, last : Option(&T).None }`, `last = .Some(o)`) is fine.
- An IMPLICIT capture is writable only in an `FnMut`/`FnOnce` closure that owns its record; in an `Fn`
  closure or a literal lent to a borrowing parameter (`run(&(() => …))`) it is E0913. Spell `{ &mut s }`.
  Calling an `FnMut` closure through a `&` capture (`{ r : &f }`) is E0908.
- An `FnMut` closure's implicit captures are owning moves: an implicit capture of a borrowed place is
  E0901. Spell `{ &p }` / `{ p }` (copies the `&T`) / `{ m : &mut m.* }` (reborrow) / `{ v : p.clone() }`.
- While a closure's `&` capture of `x` is in scope, every `&mut` lend of `x` is E0910; a `&mut` capture
  entry, `consume(x)` and a moving implicit capture count as accesses (E0911).
- Call it through `mut(f)`, `f : &mut Impl(FnMut(...))`, `(mut(d) : Dyn(FnMut(...)))` or a temporary; an
  unmarked binding or by-value parameter is E0917 (rebind `mut(g) := f;`), `f : &Impl(FnMut(...))` is
  E0908, a call while a borrow of it lives E0911. A literal passed to `&mut Impl(FnMut(...))` needs no
  marker.
- A literal that HOLDS a `&mut` capture is `FnMut` by its captures alone, so at an `Fn(...)` slot it is
  E0913.
- An `FnMut` closure (and `Dyn(FnMut(...))`) is move-only. A `Sync` slot (`Impl(Fn(...), Sync)`) rejects a
  closure that writes a `&mut` capture or its state.
- Every std non-escaping callback takes `&mut Impl(FnMut(...))` (the `Option`/`Result` combinators,
  `for_each`, `fold`, `RefCell.with`, `with_lock` bodies, `Once.call`, the `*_lazy` loggers): a closure that
  holds a reference cannot be moved into a by-value slot (E0909, even `Impl(FnOnce(...))`). `Fn` remains only
  where the callback is shared, stored, or called from another thread (`thread.spawn_blocking`'s `sink(cb)`,
  the http `handler`).
- Combinator closures take the item by value, as Rust's (`opt.map(v => …)`, `it.map(x => …)`,
  `fold((acc, x) => …)`, `for_each`, `any`, `all`, `position`, `filter_map`); `filter`, `find`,
  `take_while`, `skip_while` and `Option.inspect` lend it (`&A`).

### Function-pointer slots

- **A `=>` closure never fills a bare `fn(...)` slot** (E0605): a `fn(...) -> R` parameter or field is a C
  function pointer; it takes a named `fn` or a capture-free `->` literal. Declare `Impl(Fn(...))` or
  `Dyn(Fn(...))` for closures.
- **A bare `fn(...)` slot type never mentions `Impl(Fn(...))`**: a parameter, field or result typed
  `(fn(x : i32) -> Impl(Fn() -> i32))` or `(fn(f : &Impl(Fn() -> i32)) -> i32)` is rejected at `check`
  (each `Impl` return is its own closure struct). Take the function generically
  (`mk : &Impl(Fn(x : i32) -> Impl(Fn() -> i32))`, or `generic(G : Type), mk : &Impl(Fn(x : i32) -> G), where(G <: (Fn() -> i32))`)
  or return `Dyn(Fn(...))`. Still valid: `fn(...) -> Impl(Future(...))`, a `comptime(f)` parameter, a local
  annotation.
- **An `Impl(Fn(...))` parameter accepts only a CALLABLE** (E0606 "Argument for parameter "f" is not
  callable"): a closure, an arrow literal, a named `fn`, a `(fn(...) -> T)(...)` literal, a
  `ClosureType({...})` value, a closure forwarded from another `Impl(Fn)`/`Dyn(Fn)` slot, or an unresolved
  type variable. `io.async` follows the same rule, so a bare block is an error:

```yo ignore
io.async({ w := i32(5); w })     // WRONG — a block is not a closure
io.async(e => { w := i32(5); w }) // CORRECT — name the bundle parameter
```

## `Dyn`

### `Dyn` is unsized: `Box(Dyn(T))`, `Rc(Dyn(T))`, `&Dyn(T)` (decision 49)

`docs/en-US/TRAIT_OBJECTS.md`.

- `Dyn(T)`, `[T]` and a struct with an unsized last field live behind a pointer, and the owner is spelled:
  `dyn(Box.new(v))` → `Box(Dyn(T))`, `dyn(Rc.new(v))` → `Rc(Dyn(T))`, `dyn(&v)` / `dyn(&mut v)` →
  `&Dyn(T)` / `&mut Dyn(T)` (no allocation); `&b.*` lends an owned one.
- `downcast(&b.*, V)` gives `Option(&V)`; `upcast(p, Dyn(A))` keeps the pointer kind.
- An unsized type by value is E0619; `unsize(a)` of a value and `dyn(v)` of a plain value are E0620.
- `generic(T : ?Sized)` opts a generic in; a trait's associated type opts in the same way
  (`Target : ?Sized`; `Self.Target` then lives only behind a pointer).
- `AnyError` is `Box(Dyn(Error, Clone))` (`std/error.yo`); `d.clone()` copies a `Dyn(Trait, Clone)`. `throw`
  takes the error by value, so a handler owns what it catches.

### A callable into a `Dyn(Fn(...))` slot is always spelled (E0618)

A named closure, a named `fn`, an `Impl(Fn(...))` parameter or a closure literal passed BARE into a
`Dyn(Fn(...))` binding, reassignment, field, argument, variant payload or result is E0618; its help names the
erasure for the slot's pointer: `dyn(Box.new(f))`, `dyn(Rc.new(f))` or `dyn(&f)` (`Box.new` moves `f`, so one
closure fills one slot). `yo fix <path>` writes it for a named callable. An `Impl(Fn(...))` slot takes the
closure bare. `dyn(Box.new(nine))` of a named `fn` boxes its code pointer. A generic type's function taken
as a value (`ArrayList(i32).new`) is not emitted yet
(`issues/a-generic-types-function-taken-as-a-value-is-not-emitted.md`): wrap it,
`dyn(Box.new(() => ArrayList(i32).new()))`.

## Generics and traits

### Bounds

- `<:` is the bound operator, read *implements*: `L <: R` says type `L` implements trait `R`. `L` is a
  binder, `Self`, a projection `Self.X` or an application `F(A)`; `R` is a trait, an applied trait (`Eq(T)`,
  `Iterator(Item := A)`), a grouped `(Fn(x : A) -> B)`, `!Tr`, or in `where` a tuple `(A, B)`. Yo has no
  subtyping: `<:` never relates two types or two traits.
- It is written in the `where(...)` of a function, a type constructor, a `trait(...)` (supertraits,
  associated-type bounds), an `impl` (on its own `generic(...)` binders only) and a `derive`; and as the
  expression `(T <: Tr)`, the impl used as a namespace (`(T <: Tr).m(a)`).
- A type binder's `:` takes a kind and nothing else: `Type`, `?Sized`, `Type.Struct`, `Origin`, `Trait`
  (`comptime(marker) : Trait`) or a constructor kind (`fn(comptime(T) : Type) -> comptime(Type)`).
  `generic(T : Tr)`, `generic(T : (A, B))`, `generic(T <: Tr)`, `where(T : Tr)` and `trait(Item : Tr)` are
  E0624 (`yo fix` moves the bound into `where(...)`).
- A value's `:` takes a type: `Impl(Tr)`, `&Dyn(Tr)`, `Box(Dyn(Tr))`, never `Tr` (`a : Tr`, `a : &Tr`,
  `-> Tr`, `(x : Tr) = v`, `struct(v : Tr)` are E0625). `T <: Eq` is E0603: write `T <: Eq(T)`.
- Rust's `T: A + B` is `generic(T : Type), where(T <: (A, B))` (`T <: A + B` is E0003 with that hint).

### Generic calls

- Two arguments binding one `generic(A)` to different types is E0601; a literal and the type it adopts are
  one binding (`pair_same(i32(3), 4)` is fine).
- A `=>` closure or `->` literal argument is matched AFTER the others, against the solved parameter type:
  `apply((x) => (x + i32(1)), i32(3))` works; a body disagreeing with the solved result is E0604.
- A binder only the RESULT mentions (`mk :: fn(generic(T)) -> Option(T)`) comes from the expected type
  (`(x : Option(i32)) = mk()`) or `generic(...)`; `x := mk()` is E0613.
- A kind-annotated binder is inferred from an instantiation: `x : F(A)` given `Option(i32)` binds `F = Option`,
  `A = i32`.
- `where(I <: Iterator(Item := A))` binds `A` from the argument's impl; `J` in `F <: (Fn(item : A) -> J)`
  comes from the closure's body; `Dyn(Fn(x : A) -> B)` parameters infer `A`/`B` too.
- **Associated-type bindings work only on BARE trait names**: `where(Self <: Iterator(Item := A))` is fine;
  `where(T <: Add(T, Output := T))` is E0603 (`Add(Rhs)` is a trait constructor). Use the plain bound
  (`where(T <: (Add(T), Default))`) and let specialization resolve `Output`.

### Calling a method through its type: `T.m(x)`

- `Point.norm(p)` is `p.norm()`. A generic type works with its arguments written (`Rc(i32).clone(w)`) or
  left out (`Rc.clone(w)`, `Pair.first(p)`): inferred from the FIRST argument, which must be an instance of
  the constructor (decision 32).
- A static method (first parameter not `Self`) infers them from every argument whose parameter type
  mentions the impl's binders: `Pair.make(i32(1), true)`, `Rc.new(x)`, `Rc.new(42)` is `Rc(i32)`. Not
  consulted: a closure literal, an enum shorthand `.X`, a `dyn(...)` value, a defaulted argument, the
  expected type — so `Rc.new(.None)` and `ArrayList.new()` are E0613 (write `Rc(Option(i32)).new(.None)`);
  disagreeing arguments are E0601; two fitting impls an ambiguous E0613; a failed impl bound E0602.
- A first argument of another type (`Rc.clone(b)` for `b : Rc(i32)`; no payload search) is E0613; a missing
  method E0610.
- The match is by constructor identity: an alias or a partial application (`Pair(i32, _)`) is its own
  constructor, so `IntPair.first(q)` for `q : Pair(i32, u8)` is E0613 (write `Pair.first(q)` or
  `IntPair(u8).first(q)`). A labeled receiver (`Pair.first(self : p)`) and a module-qualified constructor
  (`m.Pair.first(p)`) work.

### Trait method dispatch

```yo
use_t1 :: (fn(generic(T : Type), self : T, where(T <: T1)) -> i32)({
  return(self.get_number()); // implicit: dispatches to T1.get_number
});

use_t2 :: (fn(generic(T : Type), self : T, where(T <: T2)) -> i32)({
  return((T <: T2).get_number(self)); // explicit trait selection
});
```

Use the explicit form when a type has several traits with the same method name, or the receiver type does
not determine the trait.

### Partial application with `_`

`_` as an argument partially applies a COMPTIME function (one with a `comptime` return type); the argument
count must match; runtime functions do not take `_`.

```yo
IntResult :: Result(_, i32); // fn(comptime(T) : Type) -> comptime(Type)
add :: (fn(comptime(x) : i32, comptime(y) : i32) -> comptime(i32))(x + y);
add1 :: add(i32(1), _);
result :: add1(i32(2)); // 3
```

### Derives

- The prelude registers derive rules for `Eq`, `Hash`, `Clone`, `Ord`, `Default` only. `derive(X, Debug)`
  needs `{ Debug } :: import("std/fmt");` first (rule in `std/fmt/to_string.yo`), `derive(X, Error(...))`
  `std/error`; otherwise "derive: trait 'Debug' does not have a derive rule". `Display` has no derive rule:
  write `impl(X, Display(fmt : (fn(self : &Self, f : &mut Formatter) -> unit)(...)))`.
- A top-level `derive(T, …)` is order-independent like `impl(T, …)`.

## Modules

### Module imports

```yo
{ RegexNode, CharRange, GroupNameEntry } :: import("./node.yo"); // same directory: relative path
node_module :: import("./node.yo"); // whole module
{ ArrayList } :: import("std/collections/array-list"); // std: "std/<module>"
{ ... } :: import("std/string"); // glob destructure (there is no `open(...)`)
```

- Files in the same directory import each other with relative paths (`./file.yo`); std modules with
  `"std/module"`. There is no `import "path" as name` form.
- **Module file, directory and `[modules]` key names are kebab-case** (`plans/backlog/KEBAB_CASE_NAMES.md`):
  `array-list.yo`, `import("markdown-yo/block-parser")`. A path is only a string; a whole-module binding is
  still an identifier (`array_list :: import("std/collections/array-list");`). `-` and `_` are different
  names (a wrong guess fails to resolve); a name must not start or end with `-`. `check`/`compile` warn on a
  project-local module name with `_` or an upper-case letter; `yo fix <path> --module-names` renames them and
  rewrites every `import(...)`, `[modules]` entry and `build.yo` `root :` path (`--dry-run` prints the map;
  comments, scripts and non-import strings are not rewritten).
- **Never import `std/prelude`**: it is loaded automatically and an explicit import is an error (a
  third-party `prelude.yo` is fine).
- **A bare `import("std/fmt");` binds no names**: it registers the module's impls and derive rules, but
  `eprintln` still needs `{ eprintln } :: import("std/fmt");` (E0401).
- `assert`/`panic` come from `std/assert` (`{ assert, panic } :: import("std/assert");`). Messages take any
  `Display` (template strings included); `assert(cond)` has a default message. The diverging builtin for
  value-position arms is `__yo_panic("str only")`. Its message is a literal, a `&str` parameter or a local:
  a method call in the argument (`__yo_panic(m.unwrap_or("x"))`) is E0601 against the arm's type, so bind
  it first (`issues/2026-11-24-yo-panic-with-a-method-call-message-reports-a-unify-error-against-the-arm-type.md`).

### Definition order

`::` definitions, `impl(...)` registrations and `derive(T, ...)` at module level are **order-independent**
(`docs/en-US/MODULES.md`): a body may use a later function, type, constant, method or trait
default; self- and mutual recursion work; `export(...)` may name a later definition. A pending definition is
forced on the first lookup that would miss.

- **Ordered:** imports, `pragma(...)`, module-level runtime globals (`x := v`, `(g : T) = v`), the
  `comptime(x) : T; x = v` spelling, `comptime_assert`, bare expression statements, and bindings inside an
  `impl({ ... })` block. Using one before it is bound is `forward reference to "X" (bound at line N) —
  imports, pragmas and runtime bindings are evaluated in order …`. Keep imports at the top.
- A forced definition sees only the statements before the reference that forced it: if `f` reads a global
  `(g : T) = v` and an earlier definition calls `f`, `g` is unbound (E0906, or E0610). Define ordered globals
  above the first definition that transitively reaches them.
- Cycles between constants or types are `cyclic definition: a (line N) → b (line M) → a`; a failure while
  forced adds `note: … was evaluated here because it is referenced before its definition`.
- Inside one `impl(...)` block, siblings call each other through `self.method()` / `Self.method()` (bare
  names are not forward-bound). A method in a LATER `impl(T, …)` block is not reachable from an earlier
  `impl(T, …)` block: keep mutually calling methods in one block.
- **Seed rule:** `yo build` compiles `src/` and `std/` with the seed, so a newer compiler feature is usable
  there only once `SEED_VERSION` carries it (`plans/backlog/SEED_VERSION_AUTOMATION.md`); `tests/` are
  compiled by the tree's stage-1.

## Strings

- `"hello"` is `str` (the builtin view of static bytes) at run time and `comptime_str` at compile time.
  `comptime_str` does not convert to `str` in a return: use `str.from_raw_parts((*u8)("..."), usize(N))`.
- **A `"..."` literal is never a `String`**: it widens to `str`, `*(u8)` and `*(char)` only, so passing one
  to a `String` parameter is E0601 (likewise `1.5` to an integer). Write `` `hello` `` (preferred) or
  `String.from("hello")`.
- `(*u8)("literal")` is valid; only pointer-to-pointer and `comptime_str`-to-pointer casts exist
  (`(*void)(usize(0))` is not supported).
- **An interpolation body is code**: inside `${...}` a string literal keeps its own escapes and braces or
  backticks in it are not delimiters (`` `${s.concat("\n")}` ``, `` `${f("}")}` ``, nested
  `` `${`in${x}`}` ``).
- **Escapes:** `\n \t \r \\ \" \' \0 \b \f \v` in both forms; `` \` `` and `\$` only in templates; `\uXXXX`
  (exactly four hex digits) and `\u{...}` (one to six, max 10FFFF, no surrogates) in both, a high+low
  `\uXXXX` pair combines (shared `scan_unicode_escape`, `src/utils.yo`; a malformed `\u` is a lex error).
  An unknown escape is silently literal; `\xNN` does not exist. Write a control byte with `push_byte`.
- **Indexing is BYTE-based**: `len()` is the byte count (O(1)); `at`, `substring`, `s(a..b)`, `index_of` and
  every positional argument are byte offsets, at compile time and run time. `substring` panics inside a rune
  (`try_substring` does not); rune work goes through `chars()` / `char_indices()`, the rune count is
  `s.chars().count()` (`docs/en-US/STRINGS.md`).
- Range indexing COPIES: `arr(a..b)` is a new `ArrayList(T)`, `s(a..b)` on `String` a new `String`; `str`
  ranges are zero-copy static windows. There is no aliasing view type (`Slice(T)`, `String.as_str()`,
  `ArrayList.as_slice()`, `ListView(T)` and `RawSlice(T)` are gone).

## Integers

- `+`, `-`, `*` overflow, `-MIN`, `/`/`%` by zero or `MIN / -1`, and a shift count outside `[0, width)`
  abort at run time with `file:line:col` (`docs/en-US/SYNTAX.md`, "Arithmetic and Failure Semantics").
  Arithmetic that wraps by design calls `wrapping_add` / `wrapping_sub` / `wrapping_mul`.
- On compile-time constants the same expressions are E1102; a left shift wraps the bits it shifts out as
  at run time. A test asserting wrap-around therefore needs `wrapping_*` on run-time values.

```yo
y := (i32(2147483647) + i32(1)); // ERROR E1102: Integer overflow in compile-time evaluation
z :: (i32(1) << 31); // OK: i32(-2147483648), like the run time
w :: (i32(1) << 40); // ERROR E1102: shift count 40 is out of range for i32 (0..32)
v :: -i8(-128); // ERROR E1102: -(-128) does not fit in i8
x := i32(2147483647);
q := (x + i32(1)); // runtime add: ABORTS (use x.wrapping_add(i32(1)) to wrap)
```

- **A `comptime_int` must fit the slot it enters** (E1102): a literal, `::` constant or folded expression
  takes a fixed-width type only in a slot of that type (binding, assignment, argument, field, return, joined
  arm, `T(x)`): `(y : u8) = 300`, `f(200 + 100)` for `a : u8`, `u8(300)` are errors; `(y : i8) = -128` and
  `k :: 3; (y : u8) = k` are fine. A conversion between two TYPED integers (`u8(some_i32)`) truncates
  unchecked. `1 << 40` fails because a bare literal receiver defaults to `i32`: write `u64(1) << u64(40)`.

## `unsafe`, raw pointers and FFI

### `pragma(Pragma.AllowUnsafe);` and `unsafe(...)`

- User code is memory-safe by default. Raw pointers need `pragma(Pragma.AllowUnsafe);` at the top of the
  file (after its leading `//` comments; several `pragma(...)` calls are allowed). Without it `unsafe(...)`
  is itself an error.
- Safe code cannot even HOLD a raw pointer: an expression whose type is or directly carries `*(T)`
  (`Option(*(T))`) is an error outside an unsafe-capable file (std is exempt); naming a raw pointer type, or
  a type whose representation carries one, in a parameter annotation needs the pragma too. Borrow elements
  with `for(&mut coll, x => …)`. A struct wrapping a pointer is not automatically gated, so a std API that
  hands out storage returns the POINTER (`ArrayList.ptr()`, `String.ptr()`), never a ptr+len struct.
- `unsafe(expr)` is a one-argument builtin call (a compile-time marker; lowers to its inner expression). It
  does NOT propagate through calls: a body with pointer ops wraps them locally; callers need nothing
  (`docs/en-US/MEMORY_SAFETY.md`).
- In an unsafe-capable file these are wrapped in `unsafe(...)`. The compiler enforces the wrap only on
  `extern "c"` calls; elsewhere it is the audit convention `yo unsafe-report` keys on:
  - pointer dereference `p.*` / `p.* = v` (on a raw pointer; `.*` on a reference binding is safe);
  - pointer arithmetic `p.add(n)`, `p.sub(n)` (offset by `usize` elements), `p.offset_from(q)` (→ `isize`);
  - `consume(p.* = v)` (deref-and-init);
  - `drop_in_place(p)` (prelude, `p : *(T)`): the slot is dead afterwards; re-initialize it with
    `consume(p.* = v)` or free it. Its body's `___drop(place)` builtin is an error in a file without the
    pragma, even inside a pragma'd caller's `unsafe(...)`;
  - every `extern "c"` call site (required).
- Safe without a wrap: `addr_of(x)`, passing/storing/returning pointers, pointer comparison (`==`, `<`, …:
  address identity), pointer-type casts (`(*u8)(p)`), and `asm(...)` / `extern(...)` / `c_include(...)`
  declarations (the declaration is the marker; the pragma is the file gate). `auto-generated://` code
  (macro and derive expansions) bypasses the per-call wrap.
- **`addr_of` of a `&T` parameter** (`self : &Self` included), or of a place inside it, is E0921: the
  parameter is passed as a copy (`fn_param_is_ptr_borrow`), so the pointer would dangle. Take `x : *T` (the
  caller passes `addr_of(place)`) or `x : &mut T`. A projection's `&T` parameter is a pointer and keeps
  `addr_of`; so do places behind a raw pointer or a `Box` (`addr_of(self.*)`; `addr_of(self._slot.*)` on std's `Atomic*` types, `addr_of(self._state.*…)` on its locks). `&x` anywhere that is
  not a lending argument, scrutinee, local borrow or capture entry (a field store, `(&x).m()`, a variadic C
  argument) is an error naming `addr_of(x)`.
- **`addr_of(K)` of a compile-time constant** (`K :: P(...)`, `addr_of(A(i))`, `addr_of(K.f)`) points at
  static storage and may be returned and stored; a constant holding reference-counted values cannot be
  addressed (bind it with `:=`).
- Raw slices: `*[T]` (decision 49), read with `__yo_slice_ptr` / `__yo_slice_len`, built with
  `__yo_slice_from_raw_parts`. A safe buffer parameter is a borrowed slice `buf : &mut [u8]`, passed as
  `unsize(&mut arr)`. The `&`/`&mut` rules (freeze, liveness, re-pointing, origins)
  are in `docs/en-US/OWNERSHIP_AND_BORROWING.md`; `tests/flowability-comprehensive.test.yo` pins them.

```yo
pragma(Pragma.AllowUnsafe);

main :: (fn() -> unit)({
  x := i32(42);
  p := addr_of(x);
  v := unsafe(p.*); // single expression
  unsafe(p.* = i32(12)); // assignment
  n := unsafe({
    p.* = i32(1);
    p.* + i32(2)
  }); // multi-statement block
});
```

- **`// SAFETY:` comments:** every non-obvious `unsafe(...)` site in std explains its contract (why the
  access is in bounds and the pointer live); `yo unsafe-report` shows the comment from the ~8 lines above
  each site.

```yo
match(
  self._ptr,
  // SAFETY: idx bounds-checked above (idx < self._length);
  // _ptr points at the Rc-managed heap buffer.
  .Some(_ptr) => _ptr.add(idx),
  .None => __yo_panic("ArrayList: empty")
)
```

### `extern` / `c_include`

- Every `extern "c"` call site needs `unsafe(...)`, even in a pragma'd file: the pragma authorizes
  DECLARING the symbol; the wrap marks each UB-capable call.

```yo
pragma(Pragma.AllowUnsafe);
{ memcpy, strlen } :: import("std/libc/string");

copy :: (fn(dst : *u8, src : *u8, n : usize) -> unit)({
  _ := unsafe(memcpy((*void)(dst), (*void)(src), n)); // wrap required
});

len :: (fn(s : *char) -> usize)(unsafe(strlen(s))); // wrap required
```

- `c_include(...)` and `extern(...)` evaluate to a module value: bind it (`c :: c_include(...)` then
  `c.fputs(...)`), select and rename (`{ strlen : c_strlen } :: c_include(...)`), or glob
  (`{ ... } :: c_include(...)`). A bare statement `c_include(...);` / `extern("Yo", …);` is sugar for the
  glob. Destructuring applies the no-shadowing rule (`docs/en-US/FFI.md`,
  `plans/reference/C_INCLUDE_EXTERN_MODULE_VALUE.md`).
- **Cast a `c_include`-typed integer (`ssize_t`, `off_t`, …) to a Yo integer at the binding**: comparing it
  directly can emit `// Failed to transpile` in condition position (invisible to `yo check`;
  `issues/cinclude-int-comparison-fails-to-transpile.md`):

```yo ignore
n := i64(unsafe(write(int(fd), (*void)(p), count))); // not: n := unsafe(write(...)); n <= isize(0)
if(n <= i64(0), { ... });
```

### Public std boundary: no raw pointer leaks

Every public top-level `fn(...)` in `std/` takes and returns values or `&`/`&mut` parameters. Raw `*(T)` in a
public signature is allowed only (a) in an FFI directory (`libc/`, `linux/`, `darwin/`, `cuda/`, `sys/`,
`sync/`) or (b) when the name says so (`*_cstr`, `*_ptr`, `from_raw_parts`, `as_ptr`, `raw_*`). Otherwise
use `ArrayList(u8)`/`String`, `name : &mut T`, or a borrowed slice. A parameter named `witness`, `written`
or `spare` is exempt (a safe-mode privilege token). Check with `yo public-safe-report ./std` (or `./src`;
`src/public-safe-report.yo`); keep the finding count from growing.

## Design-by-contract: `requires` / `ensures` / `invariant` / `ghost`

Backed by the Z3 verifier (`plans/backlog/FORMAL_VERIFICATION.md`). Without a verify pragma contracts lower
to run-time `assert(...)` (`comptime_assert(...)` in comptime fns); `yo verify <path>` discharges them
(`docs/en-US/FORMAL_VERIFICATION.md`).

- **Clauses go in the parameter list in this enforced order**: `generic(...)`, parameters, `where(...)`,
  `requires(...)`, `ensures(...)`, `decreases(...)`, `assumed()`. Out of order is a syntax error ("X appears
  after Y in the function signature").
- At most ONE `requires(...)` and ONE `ensures(...)`: put several predicates in one call
  (`requires(a, b, c)`). Zero-argument `requires()` / `ensures()` is an error — omit the clause.
- In `ensures`, the return value is the name a LABELED return binds (`-> (result : i32)`); there is no magic
  `result` (E0401 with a "label the return" hint). `old(expr)` is `expr` at entry.
- `where(...)` holds only trait bounds (`T <: Tr`); a `bool` predicate is the form error at definition, and
  `where(T : Tr)` is E0624. A value predicate goes in `requires(...)`.

```yo
divide :: (fn(x : i32, y : i32, requires(y != i32(0)), ensures(result == (x / y))) -> (result : i32))(
  x / y
);

increment :: (fn(n : &mut i32, requires(n.* < i32(100)), ensures(n.* == (old(n.*) + i32(1)))) -> unit)({
  n.* = (n.* + i32(1));
});
```

- **`invariant(...)` is the FIRST statement of a `while` body**; anywhere else (later, inside a branch or a
  nested block) is an error. There are no type invariants.

```yo
while(i < n, {
  invariant((i >= i32(0)) && (i <= n), acc >= i32(0)); // must be first
  i = (i + i32(1));
  acc = (acc + i);
});
```

- `ghost(name := expr)` is a spec-only binding; `ghost_fn(fn_value)` declares a spec-only function — separate
  builtins (never `ghost(some_fn)`):
  `permutation :: ghost_fn((fn(a : ArrayList(i32), b : ArrayList(i32)) -> bool)( /* ... */));`
- Pragmas: `pragma(Pragma.NoContracts);` erases all clauses; `pragma(Pragma.Verify);` proves them (a
  refutation is a compile error); `pragma(Pragma.VerifyOrAssert);` proves and falls back to the run-time
  assert when the solver budget runs out.
- Refinement aliases live in `std/spec/` (`NonZero`, `Bounded`, `Positive`, …); run-time gates
  (`check_non_zero`, `check_bounded`) construct them from unrefined values.

## Source files

- A leading UTF-8 BOM (U+FEFF at byte 0 only) is skipped by the lexer; positions are as if absent, but
  `Token.byte_offset` counts its 3 bytes. Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes one;
  write `.yo` files BOM-less with `[System.IO.File]::WriteAllText`.
