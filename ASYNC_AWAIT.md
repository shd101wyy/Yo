# Async/Await - Stackless Coroutines for Yo

## Philosophy

Yo supports **both** stackful and stackless coroutines:

- **Stackful coroutines** (`go { }`) - Using llco, for deep call stacks, C interop, simple blocking I/O
- **Stackless coroutines** (`async fn`, `await`) - Using state machines, for massive concurrency, memory efficiency

Both models run on the same worker thread pool with thread affinity - **tasks never migrate between threads**.

## Motivation

### Why Stackless Coroutines?

1. **Memory Efficiency**: Stackful coroutines need 16KB-1MB per coroutine. Stackless only need ~100-500 bytes for state.
2. **Massive Concurrency**: Can spawn millions of async tasks (like Rust/JavaScript), not just thousands.
3. **Zero-Cost Abstraction**: State machine transformation at compile time, no runtime overhead.
4. **Familiar Syntax**: `async`/`await` is proven in Rust, JavaScript, C#, Python.
5. **Better for CPU-bound tasks**: Futures can be polled without context switching.

### Why Keep Stackful Coroutines?

1. **Deep call stacks**: Can suspend from deeply nested functions without async coloring.
2. **Channel operations**: Natural blocking semantics with `ch <- value`.
3. **C interop**: Can call C libraries that use callbacks and suspend anywhere.
4. **Simple I/O**: Don't need to async-color entire call chains for simple programs.

## Design Overview

### Language Syntax

```yo
// Async function - returns Future(T)
fetch :: async fn(url: String) -> String {
  response := await http_get(url);  // Suspend here
  data := await response.read();
  return data;
};

// Calling async functions
main :: fn() -> unit {
  go {
    // Option 1: Spawn and await immediately
    result := await async fetch("https://api.example.com");
    println(result);
    
    // Option 2: Spawn as task, await later
    task := async fetch("https://api.example.com");
    // ... do other work ...
    result2 := await task;
    println(result2);
  };
};
```

### Keywords

```yo
// Stackful coroutines
go { }           // Spawn stackful coroutine
<-               // Channel send/receive

// Stackless coroutines  
async fn         // Async function type declaration
async expr       // Spawn async task IMMEDIATELY, returns Future
await            // Suspend until Future ready
```

**Important**: `async expr` spawns the task **immediately** (eager execution). The task starts running as soon as the async function is called. `await` just waits for an already-running task to complete.

```yo
// This spawns the task NOW (eager)
task := async fetch(url);  // Task is running in background

// This just waits for the result
result := await task;  // Blocks until task completes

// Fire-and-forget: task runs even if not awaited
_ = async log_to_server(msg);  // Runs in background
```

### Future Type

```yo
// Built-in Future type (compiler intrinsic)
Future :: fn(compt(T): Type) -> compt(Type)
  enum
    Pending,           // Not ready yet
    Ready(T)          // Result is available
;

// Async function signature
fetch :: async fn(url: String) -> String;
// Desugars to:
fetch :: fn(url: String) -> Future(String);
```

### State Machine Transformation

The compiler transforms async functions into state machines at each `await` point:

```yo
// Source code:
fetch_data :: async fn(url: String) -> Data {
  response := await http_get(url);
  data := await response.read();
  return data;
};

// Transformed to state machine:
struct FetchData_State {
  state: i32,                    // Current state (0, 1, 2...)
  url: String,                   // Function parameter (captured)
  response: Response,            // Local variable (persisted across await)
  data: Data,                    // Local variable
  future1: *(Future(Response)),  // Pending future from http_get
  future2: *(Future(Data))       // Pending future from read
};

FetchData_poll :: fn(state: *(FetchData_State)) -> Future(Data) {
  match state.state,
    0 => {
      // State 0: Start http_get
      state.future1 = http_get(state.url);
      state.state = 1;
      return Future(Data).Pending;
    },
    1 => {
      // State 1: Poll http_get future
      match poll(state.future1),
        .Ready(response) => {
          state.response = response;
          state.future1 = null;
          state.future2 = state.response.read();
          state.state = 2;
          return Future(Data).Pending;
        },
        .Pending => return Future(Data).Pending
      ;
    },
    2 => {
      // State 2: Poll read future
      match poll(state.future2),
        .Ready(data) => {
          state.data = data;
          state.future2 = null;
          return Future(Data).Ready(state.data);
        },
        .Pending => return Future(Data).Pending
      ;
    }
  ;
};
```

**Key Points:**
- Each `await` becomes a state transition
- Local variables used across `await` are captured in state struct
- Poll function is a switch statement advancing through states
- Variables not used after `await` are stack-allocated in each state

## Runtime Architecture

### Task Representation

```c
// Stackless async task (state machine)
typedef struct yo_async_task {
  void* state;                    // State machine state (async function state)
  yo_future_t* (*poll)(void*);   // Poll function (advances state machine)
  void (*drop)(void*);            // Cleanup function
  
  yo_worker_thread_t* owner_worker;  // Thread affinity - never changes
  yo_async_task_t* next;          // Next task in queue
  
  // Waker - called when future becomes ready
  struct {
    yo_async_task_t* task;
    void (*wake)(yo_async_task_t*);
  } waker;
} yo_async_task_t;

// Future result (runtime representation)
typedef struct yo_future {
  bool is_ready;
  void* result;                   // Pointer to result value (or NULL if pending)
  yo_waker_t waker;              // To wake the task waiting on this future
} yo_future_t;
```

### Executor Integration

The executor runs **on the same worker threads** as stackful coroutines:

```c
// Each worker has both stackful and stackless task queues
struct yo_worker_thread {
  // ... existing fields ...
  
  // Stackless async tasks
  yo_async_task_queue_t async_ready_queue;   // Ready to poll
  yo_async_task_queue_t async_waiting_queue; // Waiting on futures
};

// Worker main loop (updated)
void* __yo_worker_thread_func(void* arg) {
  yo_worker_thread_t* worker = (yo_worker_thread_t*)arg;
  
  while (!shutdown) {
    // 1. Poll I/O events (existing)
    poll_io_events(worker);
    
    // 2. Poll async tasks (new - non-blocking poll)
    poll_async_tasks(worker);
    
    // 3. Run stackful coroutine (existing - may block)
    yo_coro_t* coro = dequeue_coroutine(worker);
    if (coro) {
      run_stackful_coro(coro);
    }
    
    // 4. Sleep if idle
    if (no_work) {
      usleep(10);
    }
  }
}

// Poll all ready async tasks (non-blocking)
void poll_async_tasks(yo_worker_thread_t* worker) {
  int max_polls = 100;  // Limit to avoid starvation
  
  while (max_polls-- > 0) {
    yo_async_task_t* task = dequeue_async_task(worker);
    if (!task) break;
    
    // Poll the task (advances state machine)
    yo_future_t* result = task->poll(task->state);
    
    if (result->is_ready) {
      // Task completed
      task->drop(task->state);
      free_async_task(task);
    } else {
      // Still pending - move to waiting queue
      // Task will be woken when future becomes ready
      enqueue_waiting_async_task(worker, task);
    }
  }
}
```

### Waker Mechanism

When a future becomes ready, it must wake the waiting task:

```c
// Waker - wakes a task when future is ready
typedef struct yo_waker {
  yo_async_task_t* task;
  yo_worker_thread_t* worker;
} yo_waker_t;

void yo_wake_task(yo_waker_t* waker) {
  // Move task from waiting queue to ready queue (thread-safe)
  YO_MUTEX_LOCK(&waker->worker->queue_mutex);
  
  // Remove from waiting queue, add to ready queue
  remove_from_waiting_queue(waker->worker, waker->task);
  enqueue_async_task(waker->worker, waker->task);
  
  YO_MUTEX_UNLOCK(&waker->worker->queue_mutex);
}
```

### Await Implementation

The `await` keyword suspends the async function and yields control back to the executor:

```c
// Codegen for: data := await some_future();
// 
// Each await becomes a state machine state:
// 1. Check if future is ready
// 2. If ready: extract value, continue to next state
// 3. If pending: register waker, return Pending

case AWAIT_STATE_N:
  state->future = some_future();
  yo_future_register_waker(state->future, &state->waker);
  state->state = AWAIT_STATE_N + 1;
  return yo_future_pending();

case AWAIT_STATE_N + 1:
  if (yo_future_is_ready(state->future)) {
    state->data = yo_future_get_result(state->future);
    state->future = NULL;
    state->state = NEXT_STATE;
    // Continue to next state (fall through)
  } else {
    return yo_future_pending();
  }
```

## Integration with Stackful Coroutines

### Hybrid Usage

```yo
// Stackful coroutine (using go)
go {
  ch <- 42;  // Can block anywhere, deep call stacks
};

// Stackless async function
fetch_data :: async fn(url: String) -> Data {
  response := await http_get(url);
  data := await response.read();
  return data;
};

// Calling async from stackful (common pattern)
go {
  data := await fetch_data("http://example.com");
  println(data);
};

// Spawning stackful from async
hybrid :: async fn() -> i32 {
  ch := chan(i32);
  
  // Spawn stackful coroutine
  go {
    ch <- 42;
  };
  
  // Await on channel (async channel recv)
  value := await chan_recv_async(ch);
  return value;
};
```

### Channel Integration

Channels work with both models:

```yo
// For stackful: blocking channel operations
go {
  ch <- 42;      // Blocks until receiver ready
  val := <-ch;   // Blocks until data available
};

// For stackless: async channel operations
producer :: async fn(ch: Chan(i32)) -> unit {
  i := 0;
  while i < 10, i = (i + 1), {
    await chan_send_async(ch, i);  // Returns Future(unit)
  };
  return ();
};

consumer :: async fn(ch: Chan(i32)) -> unit {
  while true, {
    value := await chan_recv_async(ch);  // Returns Future(Option(i32))
    match value,
      .Some(v) => println(v),
      .None => break
    ;
  };
  return ();
};
```

## Thread Affinity & Scheduling

### Strict Thread Affinity

**Key Design Decision**: Async tasks **never migrate between threads**.

```c
// When spawning async task, assign to a specific worker
yo_async_task_t* yo_spawn_async_task(void* state, poll_fn_t poll_fn) {
  // Use same round-robin distribution as stackful coroutines
  size_t worker_index = atomic_fetch_add(&yo_next_worker_index, 1) % yo_coro_active_worker_limit;
  yo_worker_thread_t* worker = &yo_worker_threads[worker_index];
  
  yo_async_task_t* task = create_async_task(state, poll_fn);
  task->owner_worker = worker;  // Set once, never changes
  
  enqueue_async_task(worker, task);
  
  return task;
}

// Waking a task always re-enqueues to the SAME worker
void yo_wake_task(yo_waker_t* waker) {
  yo_worker_thread_t* worker = waker->task->owner_worker;  // Always use original worker
  enqueue_async_task(worker, waker->task);
}
```

### Benefits of Thread Affinity

1. **No synchronization overhead**: State machine state is only accessed by one thread
2. **Better cache locality**: State stays in same CPU's cache
3. **Simpler reasoning**: No data races within async task state
4. **Predictable performance**: No migration overhead

### Fairness

Async tasks are interleaved with stackful coroutines:

```
Worker Loop:
1. Poll I/O events (quick)
2. Poll ~100 async tasks (quick, state machine advancement)
3. Run 1 stackful coroutine (may take longer, can block)
4. Repeat
```

This ensures:
- Async tasks get frequent polling (low latency)
- Stackful coroutines can do blocking operations without starving async tasks
- Both models share CPU time fairly

## Memory Management

### Async Task Lifecycle

```c
// 1. Creation - allocate state machine
yo_async_task_t* task = yo_spawn_async_task(state, poll_fn);

// 2. Execution - poll repeatedly until complete
while (!task->complete) {
  yo_future_t* result = task->poll(task->state);
  if (result->is_ready) {
    task->complete = true;
  }
}

// 3. Cleanup - drop state and free task
task->drop(task->state);  // Drop state machine (calls destructors)
free(task->state);
free(task);
```

### State Machine Memory

State machines are **heap-allocated** but small:

```c
// Example: Simple async function with 2 await points
struct AsyncExample_State {
  int state;          // 4 bytes
  int x;             // 4 bytes (param)
  int a, b;          // 8 bytes (locals)
  void* future1;     // 8 bytes
  void* future2;     // 8 bytes
  yo_waker_t waker;  // 16 bytes
};
// Total: ~48 bytes (vs 16KB for stackful!)
```

## Codegen Strategy

### Async Function Transformation

The compiler performs these transformations:

1. **Identify await points**: Each `await` becomes a state transition
2. **Lift captured variables**: Variables used across await points go into state struct
3. **Generate poll function**: Switch statement with one case per state
4. **Generate state struct**: Contains all captured variables + pending futures

### Example Codegen

```yo
// Source
add :: async fn(a: i32, b: i32) -> i32 {
  x := await async_op(a);
  y := await async_op(b);
  return x + y;
};

// Generated C
typedef struct {
  int state;
  int a, b;      // Parameters (captured)
  int x, y;      // Locals (captured across await)
  yo_future_t* fut1;
  yo_future_t* fut2;
  yo_waker_t waker;
} add_state_t;

yo_future_t* add_poll(void* state_ptr) {
  add_state_t* s = (add_state_t*)state_ptr;
  
  switch (s->state) {
    case 0:
      // First await: async_op(a)
      s->fut1 = async_op(s->a);
      yo_future_register_waker(s->fut1, &s->waker);
      s->state = 1;
      return yo_future_pending();
      
    case 1:
      if (yo_future_is_ready(s->fut1)) {
        s->x = *(int*)yo_future_get_result(s->fut1);
        s->fut1 = NULL;
        s->fut2 = async_op(s->b);
        yo_future_register_waker(s->fut2, &s->waker);
        s->state = 2;
        return yo_future_pending();
      }
      return yo_future_pending();
      
    case 2:
      if (yo_future_is_ready(s->fut2)) {
        s->y = *(int*)yo_future_get_result(s->fut2);
        s->fut2 = NULL;
        int* result = malloc(sizeof(int));
        *result = s->x + s->y;
        return yo_future_ready(result);
      }
      return yo_future_pending();
  }
}

// Async function wrapper
yo_future_t* add(int a, int b) {
  add_state_t* state = malloc(sizeof(add_state_t));
  state->state = 0;
  state->a = a;
  state->b = b;
  state->waker.task = NULL;  // Set by executor
  
  return yo_create_future(state, add_poll);
}
```

## Error Handling

Async functions can return `Result` types, and the `?` operator works naturally:

```yo
fetch :: async fn(url: String) -> Result(String, Error) {
  response := await http_get(url)?;  // Propagate errors with ?
  data := await response.read()?;
  return Result.Ok(data);
};

// Using match for error handling
safe_fetch :: async fn(url: String) -> String {
  result := await fetch(url);
  match result,
    .Ok(data) => return data,
    .Err(e) => {
      log_error(e);
      return "";
    }
  ;
};
```

## Comparison: Stackful vs Stackless

| Feature | Stackful (`go { }`) | Stackless (`async fn`, `await`) |
|---------|----------------------|--------------------------------|
| **Memory** | 16KB-1MB per task | 100-500 bytes per task |
| **Max Concurrency** | ~10,000s | Millions |
| **Suspend Points** | Anywhere (deep calls) | Only at `await` |
| **Call Stack** | Full stack preserved | Only state machine |
| **C Interop** | Can call blocking C | Needs async wrappers |
| **Channel Ops** | Direct `ch <- val` | `await chan_send_async(ch, val)` |
| **Syntax** | `go { }`, `<-` | `async fn`, `await` |
| **Function Coloring** | No coloring | Async colors spread |
| **Use Case** | Simple I/O, scripts, deep nesting | High-scale services, millions of tasks |
| **Overhead** | Context switch (~1μs) | State machine poll (~10ns) |

## Implementation Phases

### Phase 1: Core Infrastructure
- [ ] Add `async fn` and `await` keywords to lexer/parser
- [ ] Parse `async fn` syntax (desugar to `fn() -> Future(T)`)
- [ ] Parse `await` expressions
- [ ] Define `Future(T)` enum type (Pending | Ready(T))
- [ ] Add async task queue to worker threads

### Phase 2: State Machine Transformation
- [ ] Analyze async function body to find all `await` points
- [ ] Generate state machine struct (captured variables + futures)
- [ ] Generate poll function (switch with state per await)
- [ ] Handle control flow (if, match, while with awaits)
- [ ] Implement waker mechanism

### Phase 3: Runtime Integration
- [ ] Integrate async I/O (async_read/write return Futures)
- [ ] Implement async channel operations (return Futures)
- [ ] Allow `await` in stackful coroutines (blocks goroutine)
- [ ] Implement `spawn` for launching async tasks
- [ ] Executor polling loop for async tasks

### Phase 4: Optimization
- [ ] Inline small async functions (zero-cost abstraction)
- [ ] Optimize state machine polls (reduce branching)
- [ ] Future pooling (reuse state allocations)
- [ ] Elide futures for immediately-ready values

## Example: Complete Async Program

```yo
open import "std";

// Async I/O returns Futures
extern "Yo",
  async_read : async fn(fd: i32, buf: *(u8), count: usize) -> isize,
  async_write : async fn(fd: i32, buf: *(u8), count: usize) -> isize
;

// HTTP client using async/await
http_get :: async fn(url: String) -> Result(String, Error) {
  fd := await tcp_connect(url)?;
  _ := await async_write(fd, "GET / HTTP/1.1\r\n\r\n")?;
  response := await read_response(fd)?;
  close(fd);
  return Result.Ok(response);
};

// Fetch multiple URLs concurrently
fetch_many :: async fn(urls: Array(String)) -> Array(String) {
  // Spawn all requests
  tasks := urls.map((url) => async http_get(url));
  
  results := [];
  for tasks, task => {
    result := await task;
    match result,
      .Ok(data) => results.push(data),
      .Err(e) => {
        log_error(e);
        results.push("");
      }
    ;
  };
  
  return results;
};

// Main using stackful coroutine
main :: fn() -> unit {
  go {
    urls := ["http://a.com", "http://b.com", "http://c.com"];
    
    // Await async function from stackful coroutine
    results := await fetch_many(urls);
    
    for results, r => {
      println(r);
    };
  };
};

export main;
```

## Summary

This design provides:

1. ✅ **Familiar async/await syntax** - like Rust, JavaScript, C#, Python
2. ✅ **State machine transformation** - zero-cost abstraction at compile time
3. ✅ **Thread affinity** - tasks never migrate between workers
4. ✅ **Hybrid model** - stackful (`go`) and stackless (`async fn`) coexist
5. ✅ **Memory efficiency** - millions of concurrent tasks (100-500 bytes each)
6. ✅ **Simple to learn** - just `async fn` and `await`

### Quick Reference

```yo
// Define async function
fetch :: async fn(url: String) -> Data {
  response := await http_get(url);
  data := await response.read();
  return data;
};

// Call from stackful coroutine
go {
  data := await fetch("http://example.com");
  println(data);
};

// Spawn async task
task := async fetch("http://example.com");  // Returns Future(Data)
result := await task;

// Or spawn and await immediately
result := await async fetch("http://example.com");

// Error handling with ?
safe_fetch :: async fn(url: String) -> Result(Data, Error) {
  response := await http_get(url)?;
  return Result.Ok(await response.read()?);
};
```

### Key Principles

1. **`async fn` returns Future** - `async fn() -> T` desugars to `fn() -> Future(T)`
2. **`async expr` spawns immediately** - task starts executing as soon as called (eager execution)
3. **`await` waits for result** - suspends until Future ready, doesn't spawn (task already running)
4. **State machines** - compiler transforms each `await` into state transition
5. **Thread affinity** - async tasks stay on assigned worker thread
6. **Hybrid execution** - stackful for simplicity, stackless for scale

### When to Use What

**Use `go { }` (stackful) when:**
- Simple scripts or small programs
- Deep call stacks with blocking operations
- C library interop with callbacks
- Don't care about 10k+ concurrent tasks

**Use `async fn` (stackless) when:**
- Building high-scale servers (100k+ connections)
- Memory is constrained
- Need millions of concurrent tasks
- Performance-critical hot paths

**The beauty**: Both models work together seamlessly! 🚀
