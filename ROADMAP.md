# Roadmap 2024

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