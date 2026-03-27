# DAG-Based Concurrent Execution & Shared Dependencies

## Problem Statement

### 1. Sequential Step Execution

The Yo build system currently executes all steps **sequentially** — each artifact is compiled one at a time, even when there are no dependency edges between them. This wastes time on multi-core machines where independent artifacts could compile concurrently.

Zig's build system models the project as a **directed acyclic graph (DAG)** of steps, enabling independent steps to run concurrently. We should do the same.

### 2. Diamond Dependency Problem

When two packages (A, B) depend on the same package (C), the current build system recompiles C separately for each consumer. This is wasteful and can cause linker issues:

```
   root
   ├── dep A → dep C@1.0
   └── dep B → dep C@1.0
```

**Same version**: C should be built once and shared.
**Different versions**: C must be built separately, but symbol conflicts in static libraries must be avoided.

---

## Design: DAG-Based Concurrent Execution

### Overview

Replace the sequential `for await` loops in `executeStep()` with a proper DAG scheduler that:

1. Builds a dependency graph from the registry
2. Determines which steps can run in parallel (no inter-dependencies)
3. Executes independent steps concurrently via `Promise.all()`
4. Respects ordering constraints (linked libraries compile before consumers)

### Algorithm: Level-Based Parallel Execution

```
1. Build adjacency list from step dependencies
2. Compute in-degree for each node
3. Initialize level 0 with all zero-in-degree nodes
4. While nodes remain:
   a. Execute all nodes at current level concurrently (Promise.all)
   b. Remove completed nodes, decrement in-degrees of dependents
   c. Newly zero-in-degree nodes form the next level
```

This is essentially Kahn's algorithm for topological sort, but executing each "wave" of independent nodes in parallel.

### Example

Given this `build.yo`:

```rust
exe :: build.executable({ name: "app", root: "./src/main.yo" });
lib_a :: build.static_library({ name: "lib-a", root: "./src/a.yo" });
lib_b :: build.static_library({ name: "lib-b", root: "./src/b.yo" });
exe.link(lib_a);
exe.link(lib_b);

tests :: build.test({ name: "tests", root: "./tests/" });

install :: build.step("install", "Build everything");
install.depend_on(exe);
install.depend_on(tests);
```

DAG levels:

```
Level 0: lib-a, lib-b, tests   (independent — compile concurrently)
Level 1: app                     (depends on lib-a, lib-b)
Level 2: install                 (depends on app, tests)
```

### Implementation Plan

#### Phase 1: Build the full DAG

Add a `buildDAG()` method to `BuildRegistry` that:

- Collects all artifacts, tests, run steps, and named steps as nodes
- Resolves `linkedArtifacts` and `dependencyNames` into edges
- Returns an adjacency list + in-degree map

```typescript
interface DAGNode {
  name: string;
  kind: "artifact" | "test" | "run" | "step";
  dependsOn: string[]; // names of nodes this depends on
}

function buildDAG(registry: BuildRegistry, rootStepName: string): DAGNode[];
```

#### Phase 2: Level-based scheduler

```typescript
async function executeDAG(
  dag: DAGNode[],
  ctx: ExecutionContext
): Promise<void> {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const nodeMap = new Map<string, DAGNode>();

  // Initialize
  for (const node of dag) {
    nodeMap.set(node.name, node);
    inDegree.set(node.name, node.dependsOn.length);
    for (const dep of node.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(node.name);
      dependents.set(dep, list);
    }
  }

  // Process levels
  const completed = new Set<string>();
  while (completed.size < dag.length) {
    // Find all ready nodes (in-degree == 0, not yet completed)
    const ready = dag.filter(
      (n) => !completed.has(n.name) && inDegree.get(n.name) === 0
    );

    if (ready.length === 0) {
      throw new Error("Cycle detected in build DAG");
    }

    // Execute all ready nodes concurrently
    await Promise.all(ready.map((node) => executeNode(node, ctx)));

    // Mark completed and update in-degrees
    for (const node of ready) {
      completed.add(node.name);
      for (const dep of dependents.get(node.name) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 1) - 1);
      }
    }
  }
}
```

#### Phase 3: Concurrency limit

Full parallelism may overwhelm the system. Add a configurable concurrency limit:

```bash
yo build install --jobs 4    # or -j4
```

Default: `os.cpus().length` (number of CPU cores).

Use a semaphore or p-limit style concurrency control within each level.

**Note**: Currently, `compileArtifact` uses global evaluator state (`clearAllGlobalImplState()`, etc.) which prevents true parallel compilation. Phase 3 requires making the evaluator/codegen state per-compilation-unit. For now, Phase 1-2 can still benefit from concurrent test execution and run steps, while artifact compilation remains serialized behind a mutex.

### Important Constraint: Global Evaluator State

The Yo evaluator currently uses extensive global state:

- `clearAllGlobalImplState()`
- `clearEnvContainingPrelude()`
- `clearAllModuleCounters()`
- `clearAllCachedTypes()`

This means **artifact compilations cannot truly run in parallel** until the evaluator is refactored to be instance-based. However, the DAG scheduler is still valuable because:

1. **Test suites** can run concurrently (they spawn separate processes)
2. **Run steps** can run concurrently
3. The DAG ordering is correct even with serialized compilation
4. Future evaluator refactoring unlocks full parallelism without changing the scheduler

For now: serialize artifact compilation via a shared mutex, but parallelize tests and runs.

---

## Design: Shared Dependency Builds

### Problem

```
root project
├── dep_A (path: ../dep_A)
│   └── dep_C (path: ../dep_C)  → builds libc.a
└── dep_B (path: ../dep_B)
    └── dep_C (path: ../dep_C)  → builds libc.a  (duplicate!)
```

Currently, `resolveDependencyArtifacts()` would compile dep_C twice (once for A, once for B), producing duplicate work and potentially duplicate symbols.

### Solution: Content-Addressed Artifact Cache

#### Same Version (Same Content Hash)

If two consumers depend on the **same dependency** (same URL+ref for git, same resolved path for path deps), the compiled artifact is built once and shared.

**Key**: Use a content hash to identify identical dependencies:

- **Git deps**: `sha256(url + commit)` — the locked commit ensures identical source
- **Path deps**: `sha256(resolved_absolute_path)` — same path = same source

```typescript
interface CompiledDependencyCache {
  // key: content hash of dependency identity
  // value: path to compiled artifact (.a file)
  cache: Map<string, string>;
}
```

When `resolveDependencyArtifacts()` processes a dependency:

1. Compute content hash for the dependency identity
2. Check cache — if hit, reuse the `.a` file path
3. If miss, compile and store in cache

Output location uses content hash:

```
yo-out/deps/<content_hash>/lib/lib<artifact>.a
```

A symlink or copy provides the human-readable path:

```
yo-out/deps/<dep_name>/lib/lib<artifact>.a → ../<content_hash>/lib/lib<artifact>.a
```

#### Different Versions

If two consumers require **different versions** of the same package name (different URLs or refs), each version gets a unique content hash and compiles separately.

**Symbol Conflict Prevention**: Since Yo's codegen already hash-mangles function names (non-exported functions), different versions produce different symbol names. For library-mode exported functions (which use plain C names), we prefix with the content hash:

```c
// dep_C@1.0: lib mode, exported "add" function
int32_t __yo_dep_abc123_add(int32_t a, int32_t b) { ... }

// dep_C@2.0: lib mode, exported "add" function
int32_t __yo_dep_def456_add(int32_t a, int32_t b) { ... }
```

The `extern "Yo"` declarations in consumers are resolved to the correct mangled name based on which version they depend on.

### Implementation Plan

#### Phase 1: Dependency Identity Hashing

```typescript
function computeDependencyHash(
  registry: BuildRegistry,
  depName: string,
  projectDir: string
): string {
  const pathDep = registry.findPathDependency(depName);
  if (pathDep) {
    const absPath = path.resolve(projectDir, pathDep.path);
    return createHash("sha256")
      .update(`path:${absPath}`)
      .digest("hex")
      .slice(0, 12);
  }

  const gitDep = registry.findDependency(depName);
  if (gitDep) {
    // Use locked commit from yo.lock for determinism
    return createHash("sha256")
      .update(`git:${gitDep.url}:${gitDep.ref}`)
      .digest("hex")
      .slice(0, 12);
  }

  throw new Error(`Unknown dependency: ${depName}`);
}
```

#### Phase 2: Compiled Artifact Cache

Add `compiledDepCache: Map<string, string>` to `ExecutionContext` or as a module-level variable.

In `resolveDependencyArtifacts()`:

```typescript
const depHash = computeDependencyHash(registry, depName, projectDir);
const cacheKey = `${depHash}:${artifactName}`;

if (compiledDepCache.has(cacheKey)) {
  // Reuse existing artifact
  const libFile = compiledDepCache.get(cacheKey)!;
  // ... add to consumer's cSources ...
  continue;
}

// Compile and cache
await compileDependencyArtifact(...);
compiledDepCache.set(cacheKey, libFile);
```

#### Phase 3: Symbol Namespacing (Future)

Only needed when different versions of the same dep exist. Defer until we encounter the use case — currently Yo pins deps to exact refs, making version conflicts unlikely.

---

## Summary

| Feature                    | Approach                                             | Priority     |
| -------------------------- | ---------------------------------------------------- | ------------ |
| DAG-based ordering         | Topological sort with level-based execution          | High         |
| Concurrent tests/runs      | `Promise.all()` within each DAG level                | High         |
| Concurrent compilation     | Blocked by global evaluator state; serialize for now | Low (future) |
| Same-dep sharing           | Content-addressed cache by identity hash             | High         |
| Different-version conflict | Symbol namespacing with content hash prefix          | Low (future) |
| Concurrency limit (`-j`)   | Semaphore-based limiting                             | Medium       |

---

## Open Questions

1. **Transitive dependency DAG**: When dep A's `build.yo` declares dep C, should the root build.yo's DAG include C? Currently, dependency build.yo files are evaluated independently. For full DAG integration, we'd need to merge sub-DAGs — defer this.

2. **Cycle detection reporting**: When a cycle is detected, how detailed should the error message be? Show the full cycle path for debugging.

3. **Progress reporting**: With concurrent execution, how to show build progress? Consider a Zig-style summary showing step count and timing.
