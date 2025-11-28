## Plan: Migrate Yo to Non-Atomic RC with Ownership Semantics

**TL;DR:** Implement in phases: (1) Add `Impl(...)` syntax creating `SomeType`, (2) Support `Impl` in `forall`/`compt` parameters, (3) Add `Copy`/`Send` marker modules with auto-derive, (4) Move semantics for Rc types, (5) Update `&`/`^` operators for new RC semantics, (6) Finally update closure/future syntax. Evaluator only.

### Key Design Decisions

- **`SomeType` already exists** with `module: ModuleType` field - no type system changes needed
- **`Impl(M1, M2, ...)`** creates a `SomeType` whose module contains the given module constraints
- **`&(x)` consumes `x`** but does NOT increment RC - RC only increments on assignment to variable or value constructor
- **Order of modules in `Impl` doesn't matter** - `Impl(Copy, Send)` equals `Impl(Send, Copy)`
- **Auto-derive `Copy`/`Send`** for structs if all fields implement the trait

### Steps

1. ✅ **Implement `Impl(module1, module2, ...)` syntax** in evaluator
   - ✅ Recognize `Impl` as special built-in that creates `SomeType`
   - ✅ `Impl(Copy, Send)` → `SomeType` with module containing `Copy` and `Send` constraints
   - ✅ Validate all arguments are `ModuleType`
   - ✅ Add type compatibility: concrete type satisfies `SomeType` if it implements all listed modules
   - ✅ Support labeled syntax: `Impl(Id)` uses `Id` as label, `Impl(MyId : Id)` uses custom label

2. ✅ **Support `Impl(...)` in `forall` parameters**
   - ✅ Parse `forall(T := Impl(Copy, Send))` - T bound to `SomeType` constraint
   - ✅ Parse `forall((T : Type) = Impl(Copy, Send))` - same with explicit annotation
   - ✅ On instantiation: check concrete type satisfies all modules in `SomeType`

3. ✅ **Support `Impl(...)` in `compt` parameters**
   - ✅ Parse `compt(T) := Impl(Copy, Send)` in regular function parameters
   - ✅ Parse `(compt(T) : Type) = Impl(Copy, Send)` with explicit annotation
   - ✅ Same constraint checking as `forall`

4. ✅ **Add `Copy` and `Send` marker modules** in `std/prelude.yo`
   - ✅ Define `Copy :: module` and `Send :: module` as empty marker modules
   - ✅ Primitives (`i32`, `boolean`, `char`, etc.) implement both `Copy` and `Send`
   - Pointer types (`*T`):
     - Always implement `Copy` (pointers are trivially copyable)
     - Implement `Send` if `T` is a value type with no borrowed references
     - **NOT `Send`** if `T` is an Rc type (borrowed reference) or contains borrowed references

5. **Add auto-derive logic for `Copy`/`Send`**
   - `struct`: auto-derive `Copy` and `Send` if all fields implement respective trait
   - `object`: never auto-derive `Copy` (Rc types are move-only); auto-derive `Send` if all fields are `Send` and type cannot form cycles
   - Add helper `typeImplements(type, traitModule)` to check trait implementation

6. **Implement move semantics for Rc types**
   - Add `isConsumed: boolean` and `consumedAt?: SourceLocation` to `Variable` interface
   - On assignment: if source type lacks `Copy`, mark source variable as consumed
   - On variable access: error "use of moved value" if variable is consumed
   - Rc types (`object`, `Dyn`) are move-only by default
   - Value types containing Rc fields are also move-only unless they implement `Copy`

7. **Update `&` operator for new RC semantics**
   - `&(x)` always consumes `x` (for non-`Copy` types)
   - `&(x)` does NOT increment RC - just creates a temporary pointer
   - RC increments only when assigning pointer to variable: `p := &(x)` increments RC
   - RC increments when storing pointer in value constructor
   - Result `*T` always implements `Copy`, never implements `Send`

8. **Implement `^` (unborrow) operator**
   - Add `^` as unary prefix operator token in lexer
   - `^(ptr)` returns `Option(T)` - `.Some(val)` if RC == 1, `.None` otherwise
   - Consumes the pointer variable

9. **Update `Fn`/`FnOnce` closure syntax** (after steps 1-8)
    - Parse `Impl(Fn(i32) -> i32)` and `Impl(FnOnce(i32) -> i32)` as closure types
    - `Fn` module implies `Copy`; `FnOnce` does not
    - `FnOnce` consumed on call

10. **Update `Future` syntax** (after steps 1-8)
    - Parse `Impl(Future(T))` as future type
    - Support `Impl(Future(T), Send)` for sendable futures

### RC Semantics Summary (from COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md)

```yo
x := box(42);       // x owns, RC = 1
y := x;             // x CONSUMED (move), y owns, RC still 1

p := &(x);          // x CONSUMED, &(x) creates temp pointer
                    // p := temp INCREMENTS RC = 2

p2 := p;            // p copied (pointers are Copy)
                    // p2 := p INCREMENTS RC = 3

q := ^(p);          // p CONSUMED, decrements RC
                    // q : Option(Box(i32))
                    // .Some if RC == 1, .None if RC > 1
```

**Key insight:** `&(x)` is a temporary that doesn't own anything. Only when you assign it to a variable or store it does RC increment.

### Further Considerations

1. **Cycle detection for auto-derive `Send`?** Object types that can form cycles (have self-referential fields) should not auto-derive `Send`. Recommend: conservative approach - if object has any `object`-typed field, don't auto-derive `Send`.

2. **`SomeType` in return position?** Should `fn() -> Impl(Copy)` be valid (returning existential type)? Recommend: Yes, allows returning "some type implementing Copy" without naming concrete type.

3. **Error message wording?** For moved values, use "use of moved value `x`" or "value `x` was consumed here"? Recommend: "use of moved value `x` (moved at line N)" for clarity.
