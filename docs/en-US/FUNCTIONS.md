# Functions

Declaring and calling functions: parameter modes and references, named and
default arguments, `never`, generics and constraints, partial application, type
methods and `recur`. Closures are in [CLOSURES.md](./CLOSURES.md), traits in
[TRAITS.md](./TRAITS.md#defining-and-implementing-traits); what a call does to ownership is in
[OWNERSHIP_AND_BORROWING.md](./OWNERSHIP_AND_BORROWING.md).

## Function Declaration

Functions are declared using the `::` operator for compile-time definitions or `:=` for runtime values.

Module-level `::` definitions, `impl(...)` registrations and `derive(T, ...)` statements are order-independent: a function may call one defined later in the file, reference itself by name, or use a method whose `impl` or `derive` appears below it. Imports, `open`, pragmas and runtime globals stay in source order. See [Definition Order](./MODULES.md#definition-order).

```yo
// Function declaration with explicit type
// function type is written as fn(args...) -> return_type
add :: (fn(x : i32, y : i32) -> i32)(
  x + y // Function body
);
// calling a function type with function body creates a function value
// Or define type first, then implementation
comptime(add) : (fn(x : i32, y : i32) -> i32);
add = _(x + y); // `_` here infers the function type from `add`
// or define the function body with anonymous function
add = ((a, b) -> (a + b)); // Type inferred from usage. Can have different parameter names
// With explicit return type
multiply :: (fn(x : i32, y : i32) -> i32)({
  return(x * y); // Explicit return
});

// Last expression is the return value
divide :: (fn(x : i32, y : i32) -> i32)(x / y);

// Function can take `comptime` parameter and can return `comptime` value, like Type:
Point :: (fn(comptime(T) : Type) -> comptime(Type))({
  return(
    struct(
      x : T,
      y : T
    )
  );
});
I32Point :: Point(i32);
BoolPoint :: Point(bool);

p1 := I32Point(x : 3, y : 4);
p2 := BoolPoint(x : true, y : false);
```

## Parameter modes are part of the function type

`fn(x : &mut i32) -> unit`, `fn(x : &String) -> usize` and `fn(x : String) -> usize` are three different types: a `&mut T` parameter is an exclusive borrow of the caller's place, a `&T` parameter is a read-only (shared) borrow, and a plain parameter is **by value**. A by-value parameter of a `Copy` type receives a copy, and one of an explicit-copy type (a move-only value, plain data without `Copy`, or an `Rc`/`Arc` handle) consumes its argument: the caller's binding ends at the call. A `sink(x)` parameter, and a closure or function argument, always move. The mode is part of the type for every parameter type, `Copy` or not, so `fn(x : &i32)` and `fn(x : i32)` differ too. A function value only fits a slot whose parameters have the same modes (and the same implicit `using(...)` parameters), however it gets there: bound to a typed name, passed as an argument (to a `fn(...)` or an `Impl(Fn(...))` parameter), stored in a field, returned, or wrapped by `dyn(...)` into a `Dyn(Fn(...))`. A closure literal takes the modes of the slot it is written for:

```yo
bump :: (fn(x : &mut i32) -> unit)({
  x.* = (x.* + i32(1));
});
(f : (fn(x : &mut i32) -> unit)) = bump; // OK
(g : (fn(x : i32) -> unit)) = bump; // Error: Incompatible types
```

The one exception is the receiver of an `impl` member: a trait method declared with `self : &mut Self` may be implemented with `self : Self`, because each call site adapts to the impl's own signature.

`&T` and `&mut T` are borrow **modes** a slot spells: they prefix the type of a parameter, a receiver (`self : &Self`, `self : &mut Self`), a closure parameter (`(v : &T) => ...`) or a labeled `Fn` slot (`Fn(v : &T) -> R`; an unlabeled `Fn(&T)` is not accepted). Anywhere a type stands on its own (`T :: &i32`, `ArrayList(&T)`, `Option(&T)`, a struct field `f : &T`) the sigil makes a **reference type** (see "Reference types" below); `&&T` is a reference to a reference: `&r` on a reference binding `r` lends `r` itself (a `&&T`; `&mut r` on a `mut(r)` binding is a `&mut &T`), so a parameter `a : &mut &(T, p)` re-points the caller's reference. Nothing coerces a `&&T` to a `&T`: the referent's reborrow is spelled `&r.*`, and a method call reaches the referent's methods through `(&r).m()` and through `rr.*.m()` (the method probe's deref step); a bare `rr.m()` on a `&&T` binding is not resolved. A borrow result (`-> &T` / `-> &mut T`) is a projection: the body yields a place written with the result's sigil, rooted at a borrow parameter, and the subscript (`x(i)`) reaches it ([TRAITS.md](./TRAITS.md#projections)).

**Origins**. A parameter's reference may name its **origin**, the set of places it points into: `x : &(T, p)` and `x : &mut(T, p)`, where `p` is declared in the signature's `generic(...)` clause with the kind `Origin`, as a type parameter is declared with `Type`. A union of declared origins is written as a tuple, `&(T, (p, q))`. The empty origin is spelled `static`: every file may spell it, and it is checked (E0923): only values that borrow no place (a literal, a read of a `static`-typed place, `&G` of an immutable module-level binding) flow into it. The second argument is read by its kind and must be an origin: a type there is an uncoded error (Yo spells a tuple type `Tuple(A, B)`, so a reference to one is `&Tuple(A, B)`), and so is a name no `generic(p : Origin)` declares or another parameter's name. An origin parameter is not a type parameter, so a function abstract only over origins is not generic and is compiled once. A projection's result type may name its origin too: `-> &(T, p)` borrows from an origin parameter, `-> &(T, xs)` from the reference parameter `xs`, and `-> &(T, (p, xs))` from either. A method's result may name its impl's origin parameter, as Rust's `Entry<'a, K, V>::or_insert(self) -> &'a mut V` does: on `impl(generic(p : Origin), H(p), get : (fn(self : &Self) -> &(i32, p))(…))` a call binds `p` by matching the receiver's type, so `h.get()` on `h : H(x)` borrows from `x`, outlives `h`, and freezes `x` while it lives; a name no parameter's type spells (the call could not bind it) is an uncoded error. A by-value parameter's place is the callee's own frame, so `-> &(T, v)` for `v : T` is error E0912. A result origin is checked. A call freezes only the arguments its result origin names, so after `r := pick(&a, &b)` with `pick` returning `-> &(T, a)`, `b` stays writable while `r` lives; an elided result origin names every reference parameter, so a conflict on an elided call carries a note naming the parameter and the spelling that releases it. The body must reach the place it yields from a parameter the origin names: another parameter is error E0923, a local or a by-value parameter E0912. An impl's result origin must be within its trait method's, for a reference result and for a by-value result that carries an origin such as `-> Option(&(T, self))` (narrower is accepted; wider, or elided against a spelled trait origin, is E0923), and a `Dyn` call maps the result origin from the trait's signature. The origin stays out of the type's identity, except the one bit whether it is the empty `static`: `Option(&(X, static))` and `Option(&X)` are two instances, while named origins erase. So `fn(generic(p : Origin), v : &(i32, p)) -> i32` is the same function type as `fn(v : &i32) -> i32`, with the same C, and `-> &(T, xs)` the same as `-> &T`. A closure trait may return a reference, `Fn(s : &T) -> &U` (its origin is per call, the call's reference arguments, and is never spelled): a named projection or a closure literal whose body yields `&place` reached from its own parameters fills the slot, and a closure that yields a place it captured is error E0923. A projection is called through any value of a projection type: a `fn(...) -> &T` parameter or field, an `Impl(Fn(...) -> &T)`, a `Dyn(Fn(...) -> &T)`, and an effect operation `ctl(...) -> &T`, whose handler resumes with a place of its own parameters. A reference's pointee (`&mut &(T, p)`), a local's annotation and a closure trait's result do not name an origin. `Origin` is a reserved type name, like `Type`.

**Reference types**. Outside a slot, `&T`, `&mut T`, `&(T, o)` and `&mut(T, o)` name a reference type: a struct or enum field (`struct(at : &(i32, p), lo : usize)`), a type argument (`Option(&i32)`, `ArrayList(&(i32, (x, y)))`) or an alias (`R :: &i32`). A type constructor declares an origin parameter as `comptime(p) : Origin` and is applied to an origin, `View(x)`, read by name: a binding's place (a local, a parameter, a module-level binding), an origin parameter in scope, or a union `(x, y)`. A field written `&T` without an origin gets a fresh origin of its own. A type may not name its own fields as an origin (`next : &(i32, self.value)` is error E0924): every reference inside a value points outward, so moving the value never dangles it. Origins stay out of the type's identity: `View(x)` and `View(y)`, or `Option(&(i32, x))` and `Option(&(i32, y))`, are one type and one C struct. A position that takes no origin rejects a type carrying one with error E0909: an `extern` signature (FFI takes raw pointers) and a module-level binding. An **inline composite** over reference types — a value-semantics struct or enum (a fieldless variant too, `Option(&mut i32).None`), a tuple, an array — constructs and passes by value. A constructor call lends each reference field's place (`at : &x`, `at : &mut x`) and the binding freezes the lent roots (E0911); returning a value whose origin names a local of the same function is E0912. A `&T` field is `Copy` (a copy shares its pointers), a `&mut T` field makes the holder move-only unless its type declares `derive(..., Copy, Clone)`, and C lowers a reference field as `const T*` / `T*`. A `match` arm that binds a reference payload (`.Some(r)` over an `Option(&T)` or an `Option(&Dyn(Trait))`) binds `r` as a reference, as `r := &x` does. `r.f`, `r.m()` and `r.*` read through it, `f(r)` lends it bare to a `&T` parameter, and a write through a `&` payload is E0908. While `r` is live, the places the scrutinee's references name are frozen (E0911). A `&T` parameter of a function whose result carries an origin is passed by pointer, like a projection's, so `.Some(r)` built from that parameter points at the caller's place. A binding of `match(&x, …)` is a reference into `x`'s place in the same way, so `match(&h.v, .Some(s) => .Some(s), .None => .None)` returned as an `Option(&T)` points into `h`. A field of reference type is read with `.*` (`h.f.*`) and re-pointed by a store: `h.f = &y` stores a lend, `h.f = r` a reference `r`, and the store is checked as the whole-holder store `h = H(f : &y, …)` is (the holder needs `mut(h)` or a `&mut` path, no borrow of `h` or of a place reached through `h.f` may be live, the holder keeps what it held and now also holds `y`, which must outlive it, E0911, and a declared field origin must contain `y`'s, E0923). `h.f = v` with `v` a value is E0926: the place the field refers to is written with `h.f.* = v`, through a `&mut` field. `&mut h.f` on a `&` field lends the field itself, a `&mut &(T, p)`, so a callee re-points it. A reference inside a container or a cell (`ArrayList(&T)`, `Rc`, `RefCell`) is an error.

**`Escapable` and borrows through a handle**. The prelude marker `Escapable` holds for a type that carries no origin: a reference, any type holding one, a closure with a borrow capture and a borrowing future are not `Escapable`; every other type is. It is derived from the type's structure, like `Send`, and is never implemented by hand (`impl(T, Escapable())` is an error). A generic function states it as `where(T <: Escapable)`, and a call that binds `T` to an origin-carrying type is error E0909 at that call. `Rc(V)` and `Arc(V)` take only an `Escapable` payload, so `Rc.new(v)` with a `v` that holds a reference is E0909 with the same message: a counted cell's payload dies when its last handle goes, at no point a borrow can be checked against. A shared borrow may reach through a handle's deref: `r := &h.*.x` and the capture `{ x : &h.*.x }` borrow the payload with the handle's place as their origin, so `h` is frozen while the borrow lives (dropping, moving or reassigning it is E0911; another handle's drop is fine, since the frozen `h` still holds the payload). The payload is read-only through a handle, so `&mut h.*.x` stays error E0919.

**Reading a reference with `.*`**. A reference binding (a `&T` or `&mut T` parameter, a local borrow `y := &place`, a capture-list borrow, a `for(&xs, x => …)` element, a binding of `match(&x, …)` or `match(&mut x, …)`) reads and writes the value it refers to with `.*`: `n.* + 1` with `n : &i32`, `r.* = v` with `r : &mut T`, `x := r.*` (a copy, as `t := s` copies). The bare name used as a whole value is error E0926: an operand (`n + 1`; operators never dereference), a by-value argument, an initializer, a returned value, the write `r = v`, and the borrow `&r` (spelled `&r.*`, the referent). Four uses of the bare name are not whole-value reads and stay as they are: a receiver, which reads through the reference (`r.field`, `r.method()`, `r(i)`); the name passed to a reference parameter (`f(r)` passes what `r` borrows); the re-point `r = &place`; and the scrutinee of `match(r, …)`, which matches through the reference, so its bindings borrow the referent's payload (and write it through a `&mut` reference). `match(&r, …)` on a reference is E0926 because the marker is redundant; `match(r.*, …)` matches a copy of the referent. On a reference to a `Box`, an `Rc` or a pointer, `r.*` is the reference's own deref and `r.*.*` the payload. The rule holds in every file, the standard library and fetched dependencies included.

```yo
first :: (fn(generic(p : Origin), v : &(i32, p)) -> i32)(v.*);
sum :: (fn(generic(p : Origin, q : Origin), a : &(i32, (p, q)), b : &(i32, q)) -> i32)(a.* + b.*);
Pair :: struct(a : i32, b : i32);
first_of :: (fn(generic(p : Origin), s : &(Pair, p)) -> &(i32, p))(&s.a);
second_of :: (fn(s : &mut Pair) -> &mut(i32, s))(&mut s.b);
```

**Impls over references**. An impl's receiver may be a reference: `impl(&C, Tr(...))`, `impl(&mut C, Tr(...))`, `impl(generic(p : Origin), &(C, p), Tr(...))`, or a blanket `impl(generic(T), where(T <: Tr), &T, Tr(...))`. Inside it `Self` is the reference, so `self : Self` takes the receiver as `&C`. `impl(C, Tr)`, `impl(&C, Tr)` and `impl(&mut C, Tr)` are three receivers; the origin is not part of the receiver, so `impl(&(C, p), Tr)` beside `impl(&C, Tr)` is error E0612, and so is a bare-variable blanket `impl(generic(T), T, Tr)` beside either (it covers `&C` too). A method call resolves by **receiver slot types**: a method's slot is its first parameter's type with `Self` substituted (`self : Self` on `impl(&C, …)` and `self : &Self` on `impl(C, …)` both have the slot `&C`). For a receiver of type `R` the probe tries `R`, then `&R` and `&mut R`, then one dereference of `R` and its borrows, and the first step at which a method applies wins; an inherent method beats a trait method at the same step, and two trait methods at the same step are error E0616, whose message names each impl and the slot they share. An owned `c` therefore takes a by-value `self` on `C` first (`xs.into_iter()` consumes) and borrows only when nothing takes it by value; `(&c).m()` and `(&mut c).m()` are the explicit borrows, which start the probe at `&C` (`(&xs).into_iter()` borrows). The explicit borrow never moves out of `c` (a by-value `self` on a type that is not `Copy` is E0901) and `(&c)` never reaches a `&mut Self` method (E0908). A method miss on a reference receiver lists the slot types probed. A receiver slot `&&C` (`self : &Self` on `impl(&C, …)`, which a trait that takes `&Self` forces) is accepted: a receiver that is a reference binding `r : &C` lends its own storage, as `(&r).m()` does; an owned place, a call result or an explicit `(&c)` has no storage to lend and the call is an error that says to bind the reference to a local first. A receiver of reference type `&U` (a binding, a field, a call result, `rr.*`) probes the slot `&U` first: `impl(U, …)`'s `self : &Self` methods and `impl(&U, …)`'s `self : Self` methods have it, and the reference is the argument. Only when nothing has that slot does the probe reach `&&U`, which a reference binding fills by lending its own storage and any other receiver cannot (E0610). An impl over references, a blanket over `&T` included, never shadows the referent's own method. An infix operator selects with the same rule: an operand that is a reference binding takes part with its reference type, so `ra == rb` on `ra, rb : &C` is the impl over `&C` (Rust's `impl PartialEq<&B> for &A`), whose `lhs : &Self` and `rhs : &Rhs` slots the bindings' own storage fills; it is never a dereference. When no impl over `&C` takes the operands (`ra == c` with `c : C`, `ra + 1`, or a `C` with no such impl) the operand is a whole-value read and E0926 asks for `ra.*`. The prelude provides `Eq(&T)` and `Ord(&T)` for every sized `T` with `Eq(T)` / `Ord(T)` (Rust's `impl PartialEq<&B> for &A`): two references compare and order as their referents, so `ra == rb`, `ra < rb` and generic code at `T := &U` (`max`, a bound `where(T <: Ord(T))`) work, and a user `impl(&C, Eq(&C))` beside them is E0612. The prelude also provides a `Hash(&T)` blanket over every sized `T` with `Hash(T)`, and `std/fmt` provides `Display(&T)` and `Debug(&T)` blankets over every sized `T` with `Display(T)` / `Debug(T)`: a reference hashes and renders as its referent, and a user `impl(&C, Hash(&C))` beside them is E0612.

Operator traits spell their operands' modes the same way, and every impl writes exactly those modes. The comparison traits `Eq` and `Ord` borrow, `(==) : (fn(lhs : &Self, rhs : &Rhs) -> bool)`, so `a == b` keeps both operands. The arithmetic, bitwise and unary traits (`Add` through `Shr`, `Neg`, `LogicalNot`, `BitNot` and their `Comptime*` twins) take their operands by value, as in Rust: `(+) : (fn(lhs : Self, rhs : Rhs) -> Self.Output)`. A by-value operand follows the parameter rules above: a `Copy` operand is copied, a `String` is shared, and a move-only operand moves into the operator. An impl that borrows an operand the trait takes by value, or the reverse, is rejected as written. A `Dyn` has no value to hand a by-value operand, so a trait whose method takes `self` by value (`LogicalNot`, `Neg`, `Add`, ...) cannot be put behind a `Dyn` for any payload (E0614).

```yo
Money :: struct(cents : i64);
derive(Money, Copy, Clone);
impl(Money, Add(Money)(Output : Money, (+) : (fn(lhs : Self, rhs : Self) -> Self.Output)(Money(cents : (lhs.cents + rhs.cents)))));
impl(Money, Eq(Money)((==) : (fn(lhs : &Self, rhs : &Self) -> bool)(lhs.cents == rhs.cents)));
```

## Call-site borrow markers

A borrowed argument is marked at the call too, so `show(&s)` (a borrow) and `take(s)` (a move) read differently: `&x` lends `x` to a `&T` parameter and `&mut x` lends the place `x` to a `&mut T` one. A method receiver is written bare (`s.len()`), and so is a borrowed parameter or local borrow passed on (it already holds a borrow).

```yo
swap(&mut x, &mut y);
show(&s); // s stays usable
take(s); // moved
```

`&x` is only this marker. Passed to a by-value parameter it is an error naming `x` and `x.clone()`; passed to a raw-pointer parameter, or written anywhere else (a field store, a receiver `(&x).m()`, a variadic C argument), it is an error naming `addr_of(x)`, the raw-pointer address-of of unsafe code. The other places a sigil stands are a local borrow binding (`y := &place`, `y := &mut place`, see [OWNERSHIP_AND_BORROWING.md](./OWNERSHIP_AND_BORROWING.md#local-borrows)), a capture-list entry and the borrowed `for` source (`for(&mut xs, x => ...)`). A bare named place passed to a `&T` or `&mut T` parameter is E0914 naming `&x` or `&mut x`, in all code, std included; temporaries, literals, closures and operator operands need no marker.

## Named arguments

Named arguments in Yo must be provided in the same order as they are defined in the function signature:

```yo
add :: (fn(x : i32, y : i32) -> i32)(x + y);

add(3, 4); // OK: Positional arguments
add(x : 3, y : 4); // OK: Named arguments in correct order
add(3, y : 4); // OK: Mixed (positional then named)
add(y : 4, x : 3); // Error: Named arguments must be in order (x before y)
```

## The `never` type

`never` is the type of an expression that does not complete: `__yo_panic(...)`, or a call to a function declared `-> never`. It flows into every type, so a diverging arm fits whatever the other arms produce, and nothing else flows into `never`:

```yo
die :: (fn(msg : str) -> never)(__yo_panic(msg));

pick :: (fn(flag : bool) -> i64)({
  x := cond(flag => i32(3), true => die("unreachable")); // x : i32
  i64(x)
});
```

A `-> never` function whose body can complete is rejected (`Function body has type unit, but the declared result type is never`).

The standard library's terminators are `-> never`: `std/assert`'s `panic`, `std/process`'s `exit`, and libc's `exit`, `_Exit`, `quick_exit` and `abort`. So `.None => panic("no value")` fits an arm that must produce a value.

## Default parameter values

Default parameter values can be defined using `?=` syntax:

```yo
create_user :: (fn(name : String, (age : i32) ?= i32(18)) -> User)(
  User(name : name, age : age)
);

create_user(name : `Alice`); // Uses defaults: age=18
create_user(name : `Bob`, age : i32(30)); // Explicit age
```

A default must be a **compile-time known value**: the compiler records it
once, where the function is defined, and passes that value whenever the
argument is omitted. What counts is whether the whole value is known, not
what the parameter's type is:

```yo ignore
(n : i32) ?= i32(18)                    // ✅ a literal
(alloc : Option(Allocator)) ?= .None    // ✅ a payload-free variant: only its tag, a constant
(alloc : Allocator) ?= Allocator.global() // ❌ holds the address of a global, fixed only at link time
(x : i32) ?= seven()                    // ❌ needs a call: error E1105 at the definition
```

Names in a default resolve where the function is defined, not where it is
called: a default `K` reads the defining module's `K` even when the caller
has a `K` of its own.

When the natural default needs runtime work, default to `.None` and decide in
the body. An omitted argument then reads as "not given" instead of as a
sentinel value:

```yo
greet :: (fn(name : str, (greeting : Option(String)) ?= .None) -> String)(
  match(
    greeting,
    .Some(g) => `${g}, ${name}`,
    .None => `Hello, ${name}`
  )
);

greet("Ada"); // "Hello, Ada"
greet("Ada", greeting : .Some(String.from("Hi"))); // "Hi, Ada"
```

The caller writes `.Some(...)` explicitly: a `T` is not wrapped into
`Option(T)` automatically.

## Generic function

You can use `generic` to define generic functions:

```yo
identity :: (fn(generic(T : Type), arg : T) -> T)(arg);

x := identity(12); // Type inferred: x: i32
y := identity(true); // Type inferred: y: bool
```

A generic body is type-checked when it is specialized: its result must match the declared
result type at every instantiation (`(fn(generic(T : Type), x : T) -> i32)(true)` is an E0604 at
the first call).

A type parameter stands for ONE type in a call, and the call's arguments, not their order,
decide it:

```yo
pair_same :: (fn(generic(A : Type), x : A, y : A) -> A)(x);
pair_same(i32(3), i32(4)); // A = i32
pair_same(String.from("a"), i32(2)); // E0601: A is String from argument 1 but i32 from argument 2

apply :: (fn(generic(T : Type), f : Impl(Fn(x : T) -> T), v : T) -> T)(f(v));
apply(x => (x + i32(1)), i32(3)); // 4 — the closure is checked after `v` fixed T = i32
apply(x => true, i32(3)); // E0604: the closure's body is bool, T is i32
```

A closure (`=>`) or function literal (`->`) argument is checked last, against the parameter type
the other arguments solved. A type parameter that appears only in the result is fixed by the
expected type; with none it is E0613:

```yo
mk :: (fn(generic(T : Type)) -> Option(T))(.None);
(x : Option(i32)) = mk(); // T = i32 from the annotation
y := mk(generic(bool)); // T = bool, explicitly
z := mk(); // E0613: cannot infer T
```

A `comptime(x) : T` parameter is specialized on its VALUE, so its argument must be known at
compile time — a literal, a `::` constant or the result of a comptime function. A runtime value is
an error:

```yo
scale :: (fn(comptime(factor) : i32, x : i32) -> i32)(factor * x);
scale(3, n); // OK
scale(i32.default(), n); // error[E1101]: Parameter `factor` is `comptime` and requires a compile-time argument
```

## Type constraints

You can use `where` clause to add type constraints on generic parameters:

```yo
add :: (fn(generic(T : Type), x : T, y : T, where(T <: Add(T))) -> T)(x + y);
```

`where` clause can specify multiple constraints:

```yo
compare_and_add :: (
  fn(
    generic(T : Type),
    x : T,
    y : T,
    z : T,
    where(T <: (Add(T), Eq(T)))
  ) -> T
)(
  cond(
    (x == y) => (x + z),
    true => (y + z)
  )
);
```

An associated-type binding in a bound binds a generic parameter: `A` below is fixed by the
argument's `Iterator` impl, so the body can use it, and the blanket combinators (`fold`, `map`,
`collect`, ...) can be called on the parameter. A bound may mention the parameter it constrains
(`A <: Add(A)`); it is checked once `A` is bound:

```yo
sum :: (fn(generic(I : Type, A : Type), it : I, zero : A, where(I <: Iterator(Item := A), A <: Add(A))) -> A)(
  it.fold(zero, (acc, x) => (acc + x))
);
total := sum(list.into_iter(), i32(0)); // A = i32
```

A parameter fixed only by an `Fn` bound's result (`J` in `where(F <: (Fn(item : A) -> J))`) is
bound from the closure argument's body type. When an associated type does not match, the error
says which one: `Type ArrayListIter(String) does not implement required trait Iterator: its
associated type Item is String, not i32.`

## Partial Application with `_`

Multi-parameter type constructors can be partially applied using `_` as a placeholder. This creates a new type constructor with reduced arity:

```yo
// Result has kind: (Type, Type) -> Type
// Partial application fixes one parameter:
IntResult :: Result(_, i32); // kind: Type -> Type
StrOkResult :: Result(str, _); // kind: Type -> Type
// Use like any type constructor:
(r : IntResult(bool)) = .Ok(true); // = Result(bool, i32)
(r2 : StrOkResult(i32)) = .Err(i32(404)); // = Result(str, i32)
```

Partial application works **only** on comptime functions (functions whose return type is `comptime`). It cannot be used on runtime functions.

```yo
// Type constructors (return comptime(Type)):
IntResult :: Result(_, i32); // kind: Type -> Type
// Comptime value functions (return comptime(i32), comptime(bool), etc.):
add :: (fn(comptime(x) : i32, comptime(y) : i32) -> comptime(i32))(x + y);
add1 :: add(i32(1), _); // fn(comptime(y) : i32) -> comptime(i32)
result :: add1(i32(2)); // 3
```

Partially applied type constructors can be used as HKT generic arguments:

```yo
IntResult :: Result(_, i32);
// IntResult has kind: Type -> Type, so it can be passed where F : (Type -> Type)
```

## Type Methods

Yo supports **type methods** - methods defined within the type's trait.

**Method calls only work for:**

1. Methods defined in the type's own trait
2. Methods from implemented traits

```yo
// Define a type with methods in its trait
Point :: struct(
  x : i32,
  y : i32
);
impl(
  Point,
  // Type methods are defined in the struct's trait
  distance_from_origin : (fn(self : Self) -> f64)(
    f64(
      sqrt(
        (self.x * self.x) +
          (self.y * self.y)
      )
    )
  ),
  move_by : (fn(self : &mut Self, dx : i32, dy : i32) -> unit)({
    self.x = (self.x + dx);
    self.y = (self.y + dy);
  })
);

p := Point(x : 3, y : 4);
d := p.distance_from_origin(); // Type method call - OK
p2 := Point(x : 0, y : 0);
p2.move_by(5, 10); // `self : &mut Self` lowers to `Self*` — the receiver's address is taken automatically
// p2 is now Point(5, 10)
```

**Automatic pointer conversion for `&mut`:**

`name : &mut T` parameters lower to `T*` in C. The compiler passes the address of the lent place itself, so a receiver is written bare and an argument is lent with `&mut x`:

```yo
Point :: struct(x : i32, y : i32);
impl(
  Point,
  set_x : (fn(self : &mut Self, new_x : i32) -> unit)({
    self.x = new_x;
  })
);

p := Point(x : 3, y : 4);
p.set_x(10); // No `addr_of(p)` required — the compiler inserts it
```

### Calling a method through its type

A method can also be called on its type, with the receiver as the first argument: `Point.distance_from_origin(p)` is `p.distance_from_origin()`. A generic type is called the same way, either with its type arguments written (`Rc(i32).clone(b)`) or without them (`Rc.clone(b)`). Without them, the type arguments are inferred from the first argument, which must itself be an instance of that type constructor, as Rust infers `Rc::clone(&w)`'s `T`. This works for any generic struct or enum, not only the prelude's wrappers.

A static method (one whose first parameter is not `Self`) infers them from its arguments instead: every argument whose parameter's declared type mentions the impl's type parameters binds them, so `Pair.make(i32(1), true)` is `Pair(i32, bool).make(i32(1), true)` and `Rc.new(x)` is `Rc(X).new(x)`. Nesting works (a parameter `xs : ArrayList(T)` given an `ArrayList(String)` binds `T := String`), and a literal binds its default type (`Rc.new(42)` is an `Rc(i32)`). A closure literal, an enum shorthand `.X`, a `dyn(...)` value and a defaulted argument bind nothing, and the type the call's result is expected to have never supplies them: `Rc.new(.None)`, a call with no arguments (`ArrayList.new()`) and a type parameter no argument mentions are E0613, whose help is to write the arguments (`Rc(Option(i32)).new(.None)`). Two arguments that bind one parameter to different types are E0601, and two impls the arguments both fit are an ambiguous E0613. For a method whose first parameter is `Self` (`self : &Self`, `lhs : &Self`), a first argument that is not an instance of the constructor is E0613, and the message names the argument's type.

The receiver may be labeled like any argument (`Pair.first(self : p)`), and the constructor may be module-qualified (`m.Pair.first(p)`). The match is by constructor identity, so a constructor whose body applies another one is a constructor of its own: for an alias `IntPair :: (fn(comptime(B) : Type) -> comptime(Type))(Pair(i32, B))` or a partial application `Pair(i32, _)`, a value built as `IntPair(u8)` is a `Pair(i32, u8)`, which `Pair.first(q)` and `IntPair(u8).first(q)` accept and `IntPair.first(q)` rejects with E0613.

```yo
Pair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  struct(a : A, b : B)
);
impl(
  generic(A : Type, B : Type),
  Pair(A, B),
  first : (fn(self : Self) -> A)(self.a),
  make : (fn(a : A, b : B) -> Self)(Self(a : a, b : b))
);

p := Pair.make(i32(1), true); // static: A := i32, B := bool, from the arguments
a := Pair.first(p); // A := i32, B := bool, from the receiver `p`
w := Rc.new(i32(5));
c := Rc.clone(w); // Rc(i32).clone(w)
```

### Associated constants

An `impl` may declare a plain value member beside its methods. It is read off the type, and a generic body can read it off a type parameter. The integer types carry `MIN`, `MAX` and `BITS` this way (`u8.MAX`, `i16.MIN`, `u64.BITS`).

A constant declared as a TRAIT member can also appear in a type position of a signature, such as an `Array` length, computed or bare; the projection is resolved for each instantiation. An inherent constant does not resolve in that position yet (`issues/an-inherent-associated-constant-does-not-resolve-as-an-array-length.md`), which is why the prelude declares `BYTES`, the length behind `to_be_bytes`, through its `ByteWidth` trait.

```yo
{ println } :: import("std/fmt");

Grid :: struct(w : i32, h : i32);
impl(Grid, CELL_PX : i32(16)); // a value member beside the methods

// A generic body reads the constant off a type parameter.
bits_of :: (fn(generic(T : Type), x : T, where(T <: Integer)) -> u32)(T.BITS);

// Declared through a trait, a constant can also size an `Array`.
Width :: trait(WIDTH : usize);
impl(u8, Width(WIDTH : usize(1)));
impl(u32, Width(WIDTH : usize(4)));
pad :: (fn(generic(T : Type), x : T, where(T <: Width)) -> Array(u8, T.WIDTH * usize(2)))(
  Array(u8, T.WIDTH * usize(2)).fill(u8(0))
);

main :: (fn() -> unit)({
  println(Grid.CELL_PX); // 16
  println(`${u8.MAX} ${i16.MIN} ${bits_of(u64(0))}`); // 255 -32768 64
  println(pad(u32(7)).len()); // 8
});
export(main);
```

## recur

A `::` function calls itself, or another function of its module, by name;
this is ordinary recursion and needs no special form:

```yo
fact :: (fn(n : i32) -> i32)(
  cond(
    (n <= i32(1)) => i32(1),
    true => (n * fact(n - i32(1)))
  )
);
```

`recur` names the enclosing function literal itself. Use it in an anonymous
function, which has no name to call. Inside an `io.async` lambda, `recur`
names the lambda, not the outer function. `recur` is an ordinary call:
no tail-call optimization is applied.

```yo
(fn(x : u32, acc : u32) -> u32)(
  if(
    x == 1,
    then : acc,
    else :
      recur(x - 1, acc * x)
  )
);
```
