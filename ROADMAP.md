# Roadmap

## 2024

The order of the roadmap is not necessarily the order of implementation.  
It is just a list of things that need to be done.

- [x] Combine `effect` with `class`.
  1. [x] Migrate `class` to `interface`.
  2. [x] Migrate `instance` to `implements`.
  3. [x] Get the module import/export for `interface` working.
  4. [x] Migrate `effect` to `interface`.
- [x] Get the type constraint working
  1. [x] Get the type constraint working for `function`.
  2. [x] Get the type constraint working for `interface`.
  3. [x] Get the type constraint working for `implements`.
- [ ] 2nd-class reference
  1. [x] Disable in `let/var =` assignment.
  2. [ ] QUESTION: Disable in `let/var` destructuring?
  3. [ ] Overlapping detection.
- [ ] Pattern matching
  1. [x] Support matching the `enum` variant.
  2. [ ] Other types.
  3. [ ] Multiple patterns.
- [ ] Different types of `closure`
  1. [ ] `[own]()=> ()`
  2. [ ] `[write]()=> {}`
  3. [ ] `[read]()=> {}`
- [ ] ~~`Promise` and `await` stackless coroutine.~~
- [ ] Algebraic effect.
  1. [ ] `resume`.
  2. [ ] `abort`.
  3. [ ] Dependency injection.
  4. [ ] `abortdefer`.
- [ ] Package manager.
- [ ] Standard Library.

## To be considered

- [ ] Anonymous record.
- [ ] RAII QUESTION: Should we support this or be more explicit?
  1. [ ] Implicit `drop` method.
- [ ] (Linear) Pointer
- [ ] Loops
  - [ ] `for`
  - [ ] `while`
  - [ ] `do while`

## 2025

The roadmap from 2024 is now revised and updated for 2025, based on the new design in [DESIGN.md](./DESIGN.md).

### 2025 - September

- [x] Automatically insert **dup and **drop for reference-semantics types and types containing reference-semantics types, without optimization.
- [x] Code generation for dynamic dispatch.
- [x] Eliminate **dup and **drop operations.
- [x] Use non-atomic RC for now.
- [x] Switch to biased reference counting, [Python PEP 703](https://peps.python.org/pep-0703/), [tid](https://github.com/colesbury/nogil/blob/f7e45d6bfbbd48c8d5cf851c116b73b85add9fc6/Include/object.h#L428-L455).
- [x] Add cycle removal for reference counting.

### 2025 - October

- [x] Async/await stackless coroutine design and evaluator/codegen implementation.
- [x] Async IO design.

### To be considered

- [ ] Tail call optimization for `recur` in codegen.  
- [ ] Type reflection. I wonder if this should be done in the phase of self-hosting compiler.
- [ ] BRC optimization.
- [ ] GC optimization.
- [ ] Async/await state machine generation optimization.
