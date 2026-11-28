# Generators: a `gen` block that `yield`s, a movable value that implements `Iterator`

**Status: BACKLOG, design ready (VERDICTS-97, 2026-11-28); adoption gated by [`issues/questions/2026-11-28-generators-on-frames.md`](../../issues/questions/2026-11-28-generators-on-frames.md) after AFA-7/E-5.** Designed by VERDICTS-97 (Fable 5.2) at the maintainer's request ("Can we start designing the generator now assuming the ERRORS_AS_VALUES.md will be already implemented?"); the maintainer approved landing it as the plan of record on 2026-11-28. Nothing is built and nothing is adopted. The decision stays where the question puts it: after AFA-7 and E-5 (v0.2.88 or later), on the entry condition of §9. Audited 2026-11-28 ([#2145](https://github.com/shd101wyy/Yo/issues/2145)): the corrections are folded into §2 (G2, G7, G11), §7, §8, §9.1 and §10, and what stays open is under §11, "Found by the 2026-11-28 audit".

The fact base is `origin/develop` `bab404f2e` and the released v0.2.80. The reasoning, the measurements and the ranked alternatives are in the coordinator's `VERDICTS-97.md`; its probes, C model, census scripts and eval harness are the `v97-probes/` directory beside it. *Judgment* marks an assessment.

This plan assumes the world its prerequisites build: [`ERRORS_AS_VALUES`](ERRORS_AS_VALUES.md) through E-5 (`try`, no `ctl`, no `unwind`), [`ALLOCATION_FREE_ASYNC`](ALLOCATION_FREE_ASYNC.md) through AFA-7 (frames, static `Impl(Trait)` slots, no cell fallback), and [`REFERENCES_AND_ORIGINS`](REFERENCES_AND_ORIGINS.md) O1–O10 with [`BORROW_CHECKER_COMPLETENESS`](BORROW_CHECKER_COMPLETENESS.md) P4.

Related: [`CAPABILITIES_AND_HANDLERS`](../archive/CAPABILITIES_AND_HANDLERS.md) §5 (the record this started from), [`ASYNC_ITERATION_STREAM`](../reference/ASYNC_ITERATION_STREAM.md) (`Stream`), [`SPEC_AND_PROOF`](SPEC_AND_PROOF.md) and [`DEFAULT_ON_VERIFICATION`](DEFAULT_ON_VERIFICATION.md) (the contract form of §7), [`POST_VBD_PLAN`](POST_VBD_PLAN.md) (lanes and the release map).

## 0. Scope

**Generators plus explicit capabilities are Yo's complete answer. Yo will not add algebraic effects or general handlers.** The maintainer agreed to this position on 2026-11-28.

- **The accepted cost** is the absence of effect polymorphism ("colouring"): the sync, async and fallible variants of a combinator are written separately.
- **What would reopen it:** that bridging duplication keeps growing in std after E-3 and AFA. §12 makes it measurable.
- **What this means for the design.** No continuation is a value. `yield` takes no value back. No function is suspendable because of a parameter. A sync generator is an `Iterator` and an async one would be a `Stream`, so generators add no colour of their own.

## 1. The design

```yo ignore
// A generator function: an ordinary function whose result is the generator.
evens :: (fn(n : i32) -> Impl(Iterator(Item := i32)))(
  gen({ n }() => {
    mut(i) := i32(0);
    while(i < n, {
      yield(i);
      i = (i + i32(2));
    });
  })
);

main :: (fn() -> unit)({
  for(evens(i32(10)), v => println(`${v}`));
  // A generator is an Iterator: adapters, `next` and a move all work.
  for(evens(i32(100)).map(x => (x.* * x.*)).take(usize(3)), v => println(`${v}`));
  mut(g) := evens(i32(6));
  first := g.next();
  mut(h) := g;
  second := h.next();
});
export(main);
```

- **`gen(closure)`** is an expression. The closure is a literal with no parameters; its captures follow the closure rules (an implicit capture is by value, a capture list is exhaustive). Creating a generator runs none of its body and allocates nothing.
- **`yield(v)`** is a statement of the `gen` body. It hands `v` to the consumer and suspends; the next `next()` continues after it.
- **The value** is an anonymous, move-only type that implements `Iterator(Item := T)`. A function returns it as `Impl(Iterator(Item := T))`. `for`, every adapter, `next`, a `where(I <: Iterator(Item := T))` bound and `Box(Dyn(Iterator(Item := T)))` accept it as they accept a hand-written iterator.
- **There is no capability.** A `Yield(T)` value could not be passed to a function, captured or stored, because only the `gen` body suspends; a value with one legal use is a keyword with extra spelling (VERDICTS-97 §1.1).
- **There is no resume value and no completion value.** The body's type is `unit`; `return()` ends the generator.
- **The name.** `gen` and `yield` become reserved builtin names. The task's cooperative yield is `yield_now(io)`, which `std/async/waker.yo` already exports with the same body as `std/async`'s `yield` (§10, G-0b).

**A generator is a value, not a place.** [`ALLOCATION_FREE_ASYNC`](ALLOCATION_FREE_ASYNC.md) makes a started future a place, which works because `Future` has no method a user can call. `Iterator.next` is called by the user and every adapter holds its source by value, so a suspended generator must be a value. Its invariant:

> A generator suspended at a `yield` points only outward. It moves by memcpy like any value. While a `next` call runs, it is borrowed `&mut` and cannot move.

That is O5 applied to a struct the compiler writes: no `Pin`, no immovable type, no new kind of place. It costs rule G6 below.

## 2. The rules

| Rule | Statement |
| --- | --- |
| **G1, form** | `gen(c)`: `c` is a closure literal with no parameters. Each `gen` expression has its own anonymous type `G` |
| **G2, type** | `G <: Iterator(Item := T)`. `T` comes from the expected type when the slot gives one, otherwise from the first `yield`; every `yield(e)` checks `e : T`. Every origin `T` names is one `G` carries (G7): an item may not name a place inside the body, so `yield(&local)`, `yield(&capture.field)` of a by-value capture and `yield(x)` from `for(&local, x => …)` are errors. G6 is a liveness rule and does not catch them (the borrow's last use in the body is the `yield`). A yielded `&mut` keeps its origin live in the consumer, so holding it across the next `next()` is E0911 |
| **G3, body** | The body has type `unit`. `return()` ends the generator; `return(v)` with a value is an error. `yield(e)` has type `unit` |
| **G4, placement** | `yield` is legal only lexically inside a `gen` body and belongs to the innermost one. The body's `while`, `for`, `cond`, `match` and blocks are part of it; a nested closure or `fn` literal is another body |
| **G5, only the body suspends** | A function the body calls cannot yield for it. A callee returns a generator and the body walks it |
| **G6, no self-reference** | A borrow whose origin is the body's own local, or a by-value capture, may not be live across a `yield`. A borrow whose origin is outside the generator may. A borrow of a module-level place may not be live across a `yield` (decision 18 rule 3, as for a call) |
| **G7, origins** | `G` carries the origins of its borrowing captures by the rules of a borrowing **future** (O4, O8, "As built"), not a closure's: for a `{ xs }` capture of a reference parameter the two differ today, and §1's `flatten` is that shape (§11, the 2026-11-28 audit). A binding freezes those places until the generator's last use, returning one whose origin names a local is E0912, a reference parameter's origin forwards by substitution. `G` is `Escapable` iff it has no origin. `G` is `Send` iff its captures and the locals that live across a `yield` are, **and its body reaches no non-`Send` global, judged as a closure's is (D1: `function_reaches_non_send_global` over the body)**. `G` is a struct the compiler writes, and judged by its fields alone it is `Send` whatever its body does between two yields; that was `issues/fixed/function-values-bypass-the-d1-reach-walk.md` for closures |
| **G8, value** | `G` is move-only with drop glue. It may be moved before its first `next`, between two `next` calls and after it has finished. It is not `Clone` |
| **G9, drop** | Dropping a suspended generator drops the locals live at its suspension point, newest first, then its captures. An unstarted one drops its captures; a finished one drops nothing |
| **G10, fused** | After the body ends, `next` returns `.None` every time |
| **G11, one type per slot** | `Impl(Iterator(Item := T))` is static dispatch: two generators at one slot is an error whose help names `Box(Dyn(Iterator(Item := T)))`, a struct field cannot be typed `Impl(Iterator(...))`, and, as for a future (ALLOCATION_FREE_ASYNC §2's fourth rejection), a `Dyn` trait method, a bare `fn` type or a function-pointer type cannot have the result `Impl(Iterator(...))`: a caller has no concrete type behind it. An `Impl(Fn(...) -> Impl(Iterator(...)))` parameter stays generic |
| **G12, no cycle** | A generator whose frame would contain itself, directly or through other generators, is an error at the use that closes the cycle. The repair is a box (§4) |
| **G13, no await** | `io.await` lexically inside a `gen` body is an error; the form is reserved for async generators (§11, Q9) |
| **G14, `try`** | `try(e)` in a `gen` body is legal iff `T` is `Result(U, E)` and the error converts through `From`. On `.Err(x)` it yields `.Err(From.from(x))` and ends the generator (§5) |
| **G15, contract** | `yields(g, v => P)` in the `ensures` of the function that returns `g` (§7) |

What G6 rejects, and the two repairs:

```yo ignore
words_bad :: (fn(text : String) -> Impl(Iterator(Item := String)))(
  gen({ text }() => {
    parts := text.split(" ");
    for(&parts, p => {
      yield(p.clone()); // error: `parts` is borrowed across this yield
    });
  })
);

// Repair 1: consume the local instead of borrowing it.
words_owned :: (fn(text : String) -> Impl(Iterator(Item := String)))(
  gen({ text }() => {
    parts := text.split(" ");
    for(parts, p => {
      yield(p);
    });
  })
);

// Repair 2: walk positions; the borrow of `parts` ends before each `yield`.
words_indexed :: (fn(text : String) -> Impl(Iterator(Item := String)))(
  gen({ text }() => {
    parts := text.split(" ");
    for(parts.indices(), i => {
      yield(parts(i).clone());
    });
  })
);
```

A captured reference points outside the generator and is free across a `yield`:

```yo ignore
flatten :: (fn(rows : &ArrayList(ArrayList(i32))) -> Impl(Iterator(Item := i32)))(
  gen({ rows }() => {
    for(rows, row => {
      for(row, x => {
        yield(x.*);
      });
    });
  })
);
```

**Against the rest of the language:**

- `for` keeps its parse-time desugaring: a generator is an iterator, and the blanket `into_iter` makes it a source. [`issues/blanket-into-iter-is-not-an-intoiterator-impl.md`](../../issues/blanket-into-iter-is-not-an-intoiterator-impl.md) applies to it as to any iterator.
- A generator is never a `DoubleEndedIterator`.
- An `IntoIterator` impl names its `IntoIter` type, and a generator's type has no name (§11, Q3).
- A `gen` expression in a compile-time context is an error on day one (§11, Q7).

### Diagnostics

The texts are drafts; codes are assigned in G-1 and the cli goldens record the final wording.

```text
error: `yield` outside a `gen` body

error: this `yield` is inside a closure, not in the `gen` body
  help: a closure is its own body; walk the values instead: for(xs, x => yield(x))

error: `parts` is borrowed across this `yield`
  help: a suspended generator is a value that can move, so it cannot hold a borrow of its own
        local. Consume it (for(parts, p => ...)), walk positions (for(parts.indices(), i => ...)),
        or capture it by reference from outside the generator

error: this `yield` has type `i64`; the generator's item is `i32`

error: the generator of `walk` contains itself (walk -> walk)
  help: box the recursive use: for(Box.new(walk(t, n.left)), v => yield(v))

error: two different generators flow into one `Impl(Iterator(Item := i32))` slot
  help: a slot holds one type; use Box(Dyn(Iterator(Item := i32))) to hold either

error: `io.await` in a `gen` body
  help: a generator cannot await; await first and walk the result, or implement `Stream`

error: `try` in a `gen` body whose item is `i32`
  help: `try` yields the error and ends the generator, so the item must be a `Result`;
        match on the value instead
```

## 3. Why this shape

One paragraph each; VERDICTS-97 has the argument and the alternatives.

- **A block, not a kind of function.** `gen` is `io.async(closure)` without the capability. Functions stay functions, and the signature `-> Impl(Iterator(Item := T))` says what a caller gets.
- **A value, not a place.** The 72 iterators in std are values that move while started, and every adapter holds one by value. The place form (a cold value started in the consumer's frame, with borrows across a `yield` legal) would make a started generator something that is not an `Iterator`, and every adapter would need a twin: a new colour.
- **Rust's choices, reached from Yo's rules.** RFC 3513's `gen` blocks have a unit completion, no resume argument, no borrow across a `yield`, `?` that yields the error and stops, and delegation by a `for` loop. The RFC itself calls the borrow limit "a severe and surprising limitation" and leaves it open; §9.3's owned-source row is Yo's answer to it. Yo adds the contract (§7) and the static cycle error with its box repair (§4).

## 4. Recursion and nesting

Nesting is free: a `for` over another generator keeps it in a hidden local, which is a field of the frame, so the child's struct is embedded in the parent's.

```yo ignore
header_then_rows :: (fn(rows : &ArrayList(ArrayList(i32))) -> Impl(Iterator(Item := i32)))(
  gen({ rows }() => {
    yield(i32(rows.len()));
    for(flatten(rows), v => yield(v));
  })
);
```

Recursion cannot embed (G12). The box is written, and `yo fix` can write it:

```yo ignore
walk :: (fn(t : &Tree, at : i32) -> Impl(Iterator(Item := i32)))(
  gen({ t, at }() => {
    cond(
      (at < i32(0)) => {
        return();
      },
      true => ()
    );
    n := t.nodes(usize(at));
    for(Box.new(walk(t, n.left)), v => yield(v));
    yield(n.value);
    for(Box.new(walk(t, n.right)), v => yield(v));
  })
);
```

- `Box(G)` is enough for recursion: the box is static, because the recursive call's type is the function's own result type. std gains one forwarding impl, `Box(I) <: Iterator` when `I <: Iterator`.
- Two different generators at one slot use the erased form, `dyn(Box.new(g))` at a `Box(Dyn(Iterator(Item := T)))` slot.
- **A recursive generator is slow.** Each level is an allocation and each item passes through every level. In the model it is 35–55 times the explicit stack (§6). The idiom for a deep traversal is one generator with the stack as a local, which is at parity with the hand-written iterator:

```yo ignore
walk_flat :: (fn(t : &Tree, root : i32) -> Impl(Iterator(Item := i32)))(
  gen({ t, root }() => {
    mut(stack) := ArrayList(i32).new();
    mut(at) := root;
    while(true, {
      while(at >= i32(0), {
        stack.push(at);
        at = t.nodes(usize(at)).left;
      });
      match(
        stack.pop(),
        .None => {
          break;
        },
        .Some(i) => {
          yield(t.nodes(usize(i)).value);
          at = t.nodes(usize(i)).right;
        }
      );
    });
  })
);
```

The docs and the pack state both the idiom and the cost.

## 5. Errors

Generators are not an error mechanism. A failure is a value, and a generator's value is its item.

```yo ignore
numbers :: (fn(text : &str) -> Impl(Iterator(Item := Result(i64, ParseError))))(
  gen({ text }() => {
    for(text.split(","), field => {
      n := try(parse_i64(field.trim()));
      yield(.Ok(n));
    });
  })
);

total :: (fn(text : &str) -> Result(i64, ParseError))({
  mut(sum) := i64(0);
  for(numbers(text), r => {
    sum = (sum + try(r));
  });
  .Ok(sum)
});
```

- **`Result` items, not a `Result` at completion.** `Iterator` has no slot for a completion value, and `Stream` already puts a failure in the item.
- **`try` in a `gen` body** leaves the body through its failure channel, as `try` does in a function, a closure and an `io.async` body. A generator's channel is its item: `try` yields the `.Err` and ends the generator (G14).
- **A failure that does not end the sequence** is `yield(.Err(e))` by hand.
- **In the consumer**, `try(r)` in the `for` body returns from the consuming function, because `for` is desugared and its body is not a closure.
- A sync generator cannot do I/O (G13), so its failures are parse, decode and validation errors.

## 6. Lowering

One C struct and one `next` function per `gen` expression, built on the frame code AFA writes.

```c
struct evens_gen { uint32_t state; int32_t n; int32_t i; };   /* tag, capture, local live across the yield */

static inline Option_i32 evens_gen_next(struct evens_gen* g) {
  switch (g->state) { case 0: goto start; case 1: goto yield_5_7; default: return (Option_i32){ .tag = None }; }
start:
  g->i = 0;
  while (g->i < g->n) {
    g->state = 1;
    return (Option_i32){ .tag = Some, .value = g->i };       /* yield(i) at 5:7 */
yield_5_7:
    g->i = g->i + 2;
  }
  g->state = 2;                                                /* finished: next is None from now on */
  return (Option_i32){ .tag = None };
}
```

- `gen(...)` is the struct literal: state 0 and the captures.
- A local that does not live across a `yield` stays a C local.
- A `for` that contains a `yield` keeps its hidden iterator in the frame; when that iterator is another generator its struct is nested and its `next` is a direct call.
- The drop glue is a switch on the state (G9): the walk AFA generates for an abort.
- `--max-frame-size N` asserts on the struct, as for an async frame.

| Shared with async (AFA's frame code, parameterised by the kind of suspension) | Not used by a generator |
| --- | --- |
| Numbering the suspension points; the state switch (`state-code-gen.yo`, `state-machine-naming.yo`) | The task header and `__YO_FUTURE_PREFIX` |
| Liveness across a suspension, which decides the frame's fields (`compute_cross_boundary_variables`) | The pending status, the continuation, wakers |
| Hoisting a suspension out of the middle of an expression | The `Io` bundle slot |
| The per-state drop walk | The executor ABI and every `runtime-*.yo` file |
| Children emitted before parents; the cycle check on the embedding graph (AFA-1's await graph) | `BoxFuture` |
| `--max-frame-size`; `#line` on the generated code | |

| Concern | Answer |
| --- | --- |
| Allocation | None: the value is a struct. A box appears only where the source writes `Box.new` |
| `heap.Tlsf`, no libc | A generator calls no runtime symbol |
| wasm32-wasi, emscripten | A `switch` and `goto` in one C function: no Asyncify, no `setjmp`, no computed goto |
| Readable C | Confined to `gen` bodies, with `#line`, one label per `yield` named by its position, fields named after the locals |
| Frame size | Every crossing local has its own field at first; overlapping disjoint live ranges is a later optimisation shared with AFA |

### The model's numbers

`v97-probes/model/m2_gen.c` (VERDICTS-97 §5.3): each workload as a hand-written iterator and as the lowering above, gcc 14.3 and clang 21.1 at `-O2`, with `next` free to inline and forced out of line. A model written by hand, not compiler output; ratios of generator to hand-written:

| Workload | gcc | clang | gcc, out of line | clang, out of line |
| --- | --- | --- | --- | --- |
| W1 count `0..n` | 1.04 | 1.00 | 1.18 | 1.18 |
| W2 `filter` then `map`, a generator over a generator | 3.2 | 0.57 | 1.01 | 1.43 |
| W3 flatten rows × cols | 0.95 | 0.71 | 0.87 | 0.97 |
| W4 words of a buffer | 0.95 | 0.94 | 1.02 | 1.00 |
| W5 tree, the stack as a local | 1.04 | 1.10 | 1.27 | 0.94 |
| W6 an owned buffer live across the yield, with drop glue | 0.98 | 1.00 | 1.02 | 1.01 |
| W7 create, take 3, drop | 1.29 | 1.00 | 1.26 | 1.61 |
| W5 tree, recursive with a box per call | 48 | 55 | 39 | 35 |

- A single generator costs what its hand-written iterator costs.
- W2 under gcc is the outlier: gcc does not thread one state switch through the other. The benchmark gate names it.
- No workload but boxed recursion allocates.

*Judgment on size:* about 2,000–3,000 lines without tests (evaluator 700–1,000, codegen on the shared walker 500–800, the first verifier tier 400–600), and 5–7 lane-weeks for G-1 to G-4. If AFA's frame code cannot be parameterised, codegen is about twice that.

## 7. Contracts

**Stage 1, day one: every item satisfies a predicate.**

```yo ignore
evens :: (
  fn(
    n : i32,
    requires(n >= i32(0)),
    ensures(yields(g, v => ((v >= i32(0)) && (v < n) && ((v % i32(2)) == i32(0)))))
  ) -> (g : Impl(Iterator(Item := i32)))
)(
  gen({ n }() => {
    mut(i) := i32(0);
    while(i < n, {
      invariant((i >= i32(0)) && ((i % i32(2)) == i32(0)));
      yield(i);
      i = (i + i32(2));
    });
  })
);

sum_below :: (fn(n : i32, requires(n >= i32(0)), ensures(r >= i64(0))) -> (r : i64))({
  mut(acc) := i64(0);
  for(evens(n), v => {
    invariant(acc >= i64(0));
    acc = (acc + i64(v));
  });
  acc
});
```

- **`yields(g, v => P)`** is a specification form, legal in an `ensures` whose labelled result `g` is an iterator: every `g.next()` that returns `.Some(v)` satisfies `P`.
- **It is written on the function**, because a caller verifies against the signature. The function's `Impl(Iterator(...))` result is one `gen` expression (G11), so the clause names that expression's `yield` sites.
- **`P` reads** `v` and the function's parameters as they were at the call. A `&` parameter's referent is frozen while `g` lives only where `G` borrows it (G7), so `P` reads a `&` parameter only through a place `G`'s type names; any other read through a reference is `old(...)`, and so is a `&mut` parameter's referent. A `&` parameter the body never borrows is not frozen: a consumer that changes its referent between two `next` calls would be assumed a fact about a state that no longer holds, the F8 shape. **A run-time `old(e)` is evaluated once, when the generator is created,** and its value is a capture of `G`: the one thing creation may run.
- **The producer** owes `P[e/v]` at each `yield(e)`. A `try` that yields an `.Err` (G14) is a yield site.
- **The consumer** assumes `P[x/v]` at the head of each iteration of `for(f(args), x => …)` and in the `.Some(x)` arm of a `next`.
- **Without a verify pragma** the clause lowers to an `assert` at each `yield` site.

**There is no `yield requires`.** Dafny needs it, with `reads` and `modifies`, because its caller and its iterator share a heap. In Yo the places a generator borrows are frozen while it lives (G7) and nothing else reaches its locals, so the verifier's state for the body is unchanged across a `yield`, except for what an opaque call would also change (module-level `mut` places and shared cells, outside the subset today).

**Stage 2, G-5: the whole sequence.**

```yo ignore
copy_of :: (
  fn(xs : &ArrayList(i32), ensures(seq_of(g) == seq_of(xs))) -> (g : Impl(Iterator(Item := i32)))
)(
  gen({ xs }() => {
    mut(i) := usize(0);
    while(i < xs.len(), {
      invariant(i <= xs.len(), yielded() == seq_take(seq_of(xs), i));
      decreases(xs.len() - i);
      yield(xs(i));
      i = (i + usize(1));
    });
  })
);
```

- `seq_of(g)` is the sequence a generator produces: a function of its initial captures. `yielded()` in the body is the ghost sequence of the items so far, and `produced(g)` in a consumer's `invariant` works as it does for a list.
- A clause naming `seq_of(g)` is assumed by a caller that may never run the generator to its end, so the body must be total: every loop needs `decreases`, as in a `lemma` ([`SPEC_AND_PROOF`](SPEC_AND_PROOF.md) §4.3). Stage 1 needs no such rule: a `yields` fact is used only at an item that was received.

**In the verifier's subset on day one (G-3):** a function whose body is exactly one `gen` expression, with `yields` clauses; `while` with invariants, `cond`, `match`, contracted calls and `try` in its body; a `for` over a call to such a function, with a leading `invariant`.

**Outside it on day one**, each a `subset-error` or `outside-subset` and never a silent `ok`: `seq_of(g)`, `yielded()` and `produced(g)`; a `gen` expression that is not a function's whole body; a `yields` clause on a hand-written iterator's result; a contract carried through an adapter or a `Dyn`; termination of the consumer's loop.

## 8. std

Census of `bab404f2e` (`v97-probes/census/iterators.py`): 72 `Iterator` impls, 33 in the prelude, 29 with a `DoubleEndedIterator` impl on the same type.

| Group | Count | Verdict | Reason |
| --- | --- | --- | --- |
| Ranges | 20 | stay | `DoubleEndedIterator`, `Copy`, the hottest iterators in the language |
| `_ArrayIter`, `StringChars`, `StringBytes`, `StringCharIndices`, `StringLines`, `ArrayListIter`, `ArrayListIterPtr`, `DequeIter`, `IterRev` | 9 | stay | `DoubleEndedIterator` |
| Adapters (`IterMap` … `IterPeekable`, without `IterRev`) | 11 | stay | Named exported types, `Clone`/`Copy` derives, extra methods |
| Other `IntoIterator` targets: the owning `…Iter` types and the `…Cursor` / `…CursorMut` types | 17 | stay | An impl must name its `IntoIter` type (§11, Q3, Q8) |
| Other raw-pointer iterators (`…IterPtr`) | 6 | stay | Unsafe-facing |
| `HashMapKeys`, `HashMapValues`, `RegexMatchIter`, `ErrorChain` | 4 | G-4 converts | Returned by a method, forward-only, no named-type contract; each in an `unstable` module |
| `ArrayListChunks`, `ArrayListWindows`, `BTreeMapKeys`, `BTreeMapValues`, `BTreeMapRange` | 5 | stay | Exported by name and returned by name (`chunks`, `windows`, `keys`, `values`, `range`) from modules whose `## Stability` is `stable`, where std changes additively only. A generator's type has no name (Q3), so the conversion changes five signatures and strands five exports; it needs an exception the maintainer grants (§11, the 2026-11-28 audit) |

*Judgment.* 4 of 72 (9 with that exception) and none of the hot ones; the compiler has no `Iterator` impl. std is not the case for generators. The case is what users and models write (a tokenizer, a traversal, a paged reader, a combinatorial sequence) and each new std API that would otherwise need a struct and an impl. §9.3 measures it.

## 9. The entry condition

The question document asks for four things. Each is specified here and built by G-0c with no compiler change.

### 9.1 The executable typing model and its corpus

In the shape of N0 ([`REFERENCES_AND_ORIGINS`](REFERENCES_AND_ORIGINS.md), "N0 as built"; `tests/origins/model.yo`):

- **The corpus:** `tests/generators/corpus/<id>.yo`, plain files that `yo test` never runs, spelled in the syntax G-1 will land. `tests/generators/corpus.tsv` gives each row its rule, its kind, the diagnostic expected once the rules land and what today's compiler does with it. `scripts/generators-corpus.sh` has a `today` mode (every row parses) and a `target` mode (the verdict matches).
- **The model:** `tests/generators/model.yo`, a reference checker of G1–G14 over a toy language (bindings, borrows with origins, calls, `while`, `for`, `yield`, `gen` with a capture list, `Box`), a few hundred lines, that the corpus runs through.

| Rule | Negative rows |
| --- | --- |
| G1 | `gen` of a named closure; of a closure with a parameter; of a block |
| G2 | two `yield`s of different types; a `yield` that disagrees with the slot's `Item`; no `yield` and no expected type; `yield(&local)`; `yield(x)` from `for(&local, x => …)`; `yield(&capture.field)` of a by-value capture; a yielded `&mut` from a `&mut` capture, held across the next `next()` |
| G3 | `return(v)` with a value; a non-unit tail; `yield(v)` used as a value |
| G4 | `yield` outside any `gen`; in a closure inside the body; in a `fn` literal inside the body |
| G5 | a helper function that calls `yield` |
| G6 | `for(&local, …)` with a `yield` in the body; `r := &mut local` used after a `yield`; `for(&by_value_capture, …)` with a `yield`; a sub-generator that captures `&local`, walked with a `yield`; a cursor over a local held across a `yield`; a borrow of a module-level place across a `yield` |
| G7 | returning a generator that captures `&local`; a write to a place a live generator borrows; a borrowing generator at `io.spawn`; one in an `Rc`; one whose body writes a `mut(G)` global, judged `Send`; one whose body reads a non-`Sync` global, judged `Send` |
| G8 | use after move; `g.clone()` |
| G11 | two generators in two `cond` arms at one slot; a struct field typed `Impl(Iterator(...))`; a bare `fn` type and a `Dyn` method whose result is `Impl(Iterator(...))` |
| G12 | direct recursion without a box; mutual recursion through two generator functions |
| G13 | `io.await` in a `gen` body |
| G14 | `try` with a non-`Result` item; `try` on an `Option`; an error type with no `From`; before G-3 lands, any `try` in a `gen` body, rejected with G14's help rather than as a value returned from a `unit` closure |

Positive controls (18): a capture by value; a `&` capture used across a `yield`; a `&mut` capture written across a `yield`; a re-borrow of a local after each `yield`; a consumed local; an index walk; a nested `for` over a captured list; §1's `flatten` (a `{ xs }` capture of a reference parameter, walked across a `yield`); a yielded `&mut` dropped before the next `next()`; delegation; boxed recursion; an explicit stack; a move before the first `next`; a move between two `next` calls; a drop while suspended with an owned local; `Box(Dyn(...))` at a slot; a generator as the hidden iterator of a `for` in an `io.async` body with an `await` in the loop; `try` with a `Result` item.

**Gate:** the model accepts every positive control and rejects every negative row for the recorded rule. Each rule interaction it finds is recorded in this plan.

### 9.2 The benchmarks

- **Before the compiler:** `m2_gen.c` moves to `scripts/bench/models/`, extended with the drops a compiler would emit.
- **With G-1:** `scripts/bench/generators.yo` and `scripts/bench-generators.sh`: each workload of §6 as a hand-written `Iterator` and as a `gen` block. Measured as AFA-0 measures (`perf stat -e instructions:u` at N and at 0, the difference over N), plus allocations, `sizeof` of each frame and `nm --size-sort` on `next`; clang and gcc at `-O2`.

| Row | Gate |
| --- | --- |
| W1, W3, W4, W5 (stack as a local), W6: instructions per item | ≤ 1.25 of the hand-written iterator, both compilers |
| W2, W7 | ≤ 1.5 under clang; recorded under gcc, and W2 investigated if it stays above 2 |
| Allocations per item, every row but boxed recursion | 0 |
| Frame size, W1, W3, W4 | ≤ the hand-written struct plus one word |
| Boxed recursion | recorded, not gated |

### 9.3 The authorship eval

- **Arms.** H: a hand-written `Iterator`. K: `gen`. Each gets a one-page guide of the same length with one worked example of the same task.
- **Tasks (8).** `flatten`; `runs`; `in_order` over an index-linked tree; a tokenizer whose item is `Result(Token, LexError)`; **owned source** (split an owned `String` and yield its pieces: built to meet G6); `chunks` with a partial last chunk; **merge** of two sorted sources (the consumer steps two iterators by `next`); an unbounded sequence consumed through `take`.
- **Models and samples.** At least three model tiers; ten samples per model, arm and task.
- **Protocol.** One attempt from the guide and `yo context`; then up to three repair rounds, each given the compiler's diagnostics.
- **Measures.** First-attempt pass (parse, check, the task's tests); rounds to pass; solution lines; diagnostics by code.
- **Stage E-a, on a released compiler.** Arm K runs through a text prepass and an eager shim (`v97-probes/eval/prepass.py`, `gen_shim.yo`; both reference solutions produce the same output on v0.2.80). It covers `flatten`, `runs`, `in_order`, `chunks` and, once `try` has shipped, the tokenizer. It cannot check G6, the box rule or laziness.
- **Stage E-b, on the G-1 branch build.** All eight tasks with the real rules. This stage decides.

| Result of E-b | Reading |
| --- | --- |
| K's pooled first-attempt pass rate is at least 10 points above H's, and its repair rounds are no higher | the authorship gain is real |
| Owned source: more than 25% of first attempts fail on G6, and fewer than 80% of those are repaired in one round | the value form is wrong; the place form of §11 or no generators |
| K is within 10 points of H | no authorship case; the decision rests on §9.2 and on demand |

The thresholds are VERDICTS-97's *Judgment*. The maintainer sets them before the eval runs (§11, Q1).

A six-program pilot ran for VERDICTS-97 (Haiku, Sonnet and Opus; one sample per cell; `flatten`, `runs`, `in_order`): K passed 3 of 3 and H 2 of 3 (one parse error, E0003), and the K solutions were 0.6 of the H ones in lines. It proves the harness and is not a rate.

### 9.4 The contract form

§7 is the specification. The fixtures, written as plain files by G-0c and joined to `tests/spec` by G-3:

| Fixture | Expected |
| --- | --- |
| `evens` with its `yields` clause | proves |
| `sum_below`, which relies on it | proves |
| a generator that yields `i + i32(1)` under the same clause | refuted, with the item as the counter-example |
| a `try` that yields an `.Err` the clause forbids | refuted at the `try` |
| a clause that reads a `&mut` parameter's referent without `old` | a form error |
| a `yields` clause on a function that returns a hand-written iterator | `subset-error`, not `ok` |
| the clause in `runtime` mode with a violating generator | the assert fires at the `yield` |

### The decision

Adopt when the model is sound, the benchmarks pass their gate, and E-b shows the gain. VERDICTS-97 §10 lists what would make it recommend against:

1. the model finds a negative row the rules cannot reject;
2. the compiler's output misses the benchmark gate after one repair round, or a non-recursive generator allocates;
3. E-b shows no authorship gain, or G6 failing as the table above describes;
4. AFA lands in a shape the lowering cannot share;
5. at v0.2.88 no program asks for generators: std has 9 candidates and the compiler none.

## 10. The PRs

Nothing before the decision changes the compiler's language. Releases assume AFA-7 and E-5 at v0.2.86.

| PR | Release | Seed | Content | Size | Gate beyond Tier 1 |
| --- | --- | --- | --- | --- | --- |
| **G-0a** | now | no | This plan; the four findings below filed | S | refs check; fmt |
| **G-0b** | any time | no | Delete `std/async`'s `yield` (it duplicates `yield_now`); sweep `tests/` (569 lines), `docs/` (54) and the pack (1) | S, mechanical | develop's battery; cli-diff |
| **G-0c** | v0.2.83–87, as filler | no | §9.1's model and corpus; §9.2's C model; §9.3's stage E-a; §9.4's fixtures; §12's census script | M | the corpus in `today` mode |
| **G-0d** | before G-1 | no | Fix the two blockers below | S–M each | their probes as tests |
| **The decision** | v0.2.88 | — | The maintainer, on §9. E-b needs a build of G-1, so G-1 is written as a draft PR before the decision and merged after it | — | — |
| **G-1** | v0.2.88–89 | A | `gen` and `yield` reserved; G1–G11 and G13, with G12's detection (without it a recursive generator's embedding is infinite; only its repair waits for G-2); the lowering on AFA's frame code; the drop walk; the diagnostics; `tests/generators.test.yo` | L | the corpus in `target` mode; ASan; an emit-diff of `src/main.yo` with no change |
| **G-2** | v0.2.89 | A | G12's `yo fix` repair; `Box(I) <: Iterator`; the benchmarks | M | §9.2's table |
| **G-3** | v0.2.89–90 | A | G14 (`try`); G15 stage 1 in the verifier and the run-time asserts (lane E) | M | §9.4's fixtures |
| **G-4** | v0.2.90 | B | std converts §8's four; docs in both languages; the pack; `yo explain` for the new codes | M | develop's battery; `markdown-yo` rebuilt |
| **G-5** | on demand | A, B | Stage 2 contracts: `seq_of`, `yielded`, `produced` | M–L | — |
| **G-6** | on demand | A, B | Async generators; leaf-direct recursion; overlapped frame fields | L each | — |

- **Seed gating.** G-1 adds two builtin names and no prelude text. std writes `gen` one release after the compiler has it (G-4). G-0b needs no seed: `yield_now` is in v0.2.80's std.
- **Order.** G-0b must land before G-1 reserves `yield`.

**Found while probing (v0.2.80), filed with G-0a.** Probes are in `v97-probes/`; each doc has a reproducer under `issues/repros/` and its output under the v0.2.80 seed and a stage 1 of develop. They are general bugs, fixed whether or not generators are adopted.

| Finding | Probe | Severity | Blocks | Issue |
| --- | --- | --- | --- | --- |
| A function result typed `Impl(Iterator(Item := i32))`: `for` over it is E0610, and `it.next()` passes `yo check` and emits C that initialises one `Option` struct from another | `p01_impl_iterator_result.yo`, `p01b_impl_iterator_next.yo` | S2 | G-1 | [`issues/2026-11-28-an-impl-iterator-result-is-not-a-for-source-and-its-next-emits-invalid-c.md`](../../issues/2026-11-28-an-impl-iterator-result-is-not-a-for-source-and-its-next-emits-invalid-c.md) |
| `Box(Dyn(Iterator(Item := i32)))` passes `yo check`; the `Dyn` thunk for `next` casts a struct in the emitted C | `p01d_dyn_iterator.yo` | S2 | G-2 | [`issues/2026-11-28-a-box-dyn-iterator-next-emits-invalid-c.md`](../../issues/2026-11-28-a-box-dyn-iterator-next-emits-invalid-c.md) |
| A generic `F` bounded by `FnOnce(g : &mut ArrayList(T))` with `T` a `comptime` parameter passes `yo check`; the C passes a pointer to the wrong struct. A `.None` at `x : Option(T)` has the same cause | `p02a_generic_fnonce_sink.yo` | S2 | — | [`issues/2026-11-28-an-argument-typed-from-a-parameter-that-names-a-comptime-type-keeps-the-type-abstract.md`](../../issues/2026-11-28-an-argument-typed-from-a-parameter-that-names-a-comptime-type-keeps-the-type-abstract.md) |
| The same callback as an `Impl(FnOnce(...))` parameter: E0610, no method `new` on `ArrayList(T)`. Narrowed: any `comptime(T)` that no runtime parameter's type names leaves `T` abstract in the body, so S2 rather than the S3 VERDICTS-97 judged | `p02b_comptime_t_impl_fnonce.yo` | S2 | — | [`issues/2026-11-28-a-comptime-type-that-no-runtime-parameter-names-is-abstract-in-the-body.md`](../../issues/2026-11-28-a-comptime-type-that-no-runtime-parameter-names-is-abstract-in-the-body.md) |

No file in `std/`, `src/`, `tests/` or `docs/` spells `Impl(Iterator(` or `Dyn(Iterator(` today, which is why the first two went unseen.

**Documentation that changes at G-4** (the user docs describe only the current language): a new `docs/en-US/GENERATORS.md` with its `zh-CN` twin; `ASYNC_AWAIT.md` (`yield_now`, at G-0b); `TRAITS.md`'s iterator section; `FORMAL_VERIFICATION.md` (`yields`); `ERROR_HANDLING.md` (`try` in a `gen` body); `pack/context.md`; `.github/instructions/yo-syntax.instructions.md` (the reserved names, the `gen` form).

## 11. Rejected, and open

| Alternative | Reason |
| --- | --- |
| A generator function marked by an `out : Yield(T)` parameter, with `generator(f, args)` | A new kind of function with rules for `Yield(T)` in every position a type can stand; delegation by a plain call is the unboxed cycle, and a call has no value to box |
| A `gen` block with a capability parameter, `(out : Yield(T)) =>` | The same semantics plus a token that cannot be passed |
| The place form: a cold value started in the consumer's frame, borrows across a `yield` legal | A started generator would not be an `Iterator`; every adapter would need a twin. Reconsidered only on §9.3's evidence |
| A function is a generator because its body contains `yield` (C#, Python, JavaScript) | The body changes the function's kind with nothing in the signature |
| Push only: the body calls the consumer (Go's range-over-func) | No `next`: no `zip`, no `peekable`, no manual stepping; an early exit is a flag the author must test |
| A resume value; Rust's `Coroutine`; Python's `send` | A coroutine with a protocol: the handler with a continuation that §0 excludes |
| A completion value | A second consumer protocol beside `Iterator` |
| A `yield_all` / `yield from` form | Sugar for `for(sub, v => yield(v));`; added only on eval evidence |
| An explicit item type argument | The slot or the first `yield` already fixes it |
| Heap-allocated generator objects (C#, Python, Kotlin `sequence`, C++20 by default) | Allocation per generator; fails `heap.Tlsf` budgets for no gain |
| Stackful coroutines | Assembly per target, a stack to size, no portable wasm (VERDICTS-95 §2.4) |
| Effekt and Koka handlers | §0 |
| A task and a channel | 580 ns per item (VERDICTS-95 `g01b`) |

Open questions:

| | Question | Position |
| --- | --- | --- |
| **Q1** | §9.2's and §9.3's thresholds | The maintainer sets them before G-0c runs the eval |
| **Q2** | `Clone` for a generator whose state is `Clone` | Not on day one. A copy of a suspended generator is a fork of the iteration; wait for a use |
| **Q3** | Naming an `Impl` result type, so that an `IntoIterator` impl can name a generator as its `IntoIter` | One question with ALLOCATION_FREE_ASYNC's Q7 (naming an async function's future type). Not answered here; it bounds §8 |
| **Q4** | The spelling of a borrowing generator's origin in a signature | Whatever a borrowing future's result spells; elided means every reference parameter, as for a projection |
| **Q5** | `try` in a `gen` body: yield the error and end (G14), or an error | G14 as written (VERDICTS-97: 70%). The strict reading changes one rule and nothing else |
| **Q6** | A generator that borrows its own locals across a `yield` | The place form; only if E-b's owned-source task says so |
| **Q7** | A `gen` expression at compile time | An error on day one: the evaluator has no suspension |
| **Q8** | Yielding a `for(&xs, x => …)` item | Needs the item to be a first-class `&(T, xs)`; today `return(x)` is E0912. Until then the cursor types stay hand-written |
| **Q9** | Async generators (`Stream`) | Deferred. Needs AFA-8, `Stream.next` reshaped for it, and a rule for a `next` future dropped while the body is at an `await`. G13 keeps the form free |
| **Q10** | Recursion at O(1) per item | Leaf-direct resume (C++23 `std::generator`): 3.3–6.8 ns per item in the model against 65–86. It needs an erased generator type with a third resume status. G-6, on demand |

### Found by the 2026-11-28 audit

The audit is [#2145](https://github.com/shd101wyy/Yo/issues/2145). Its corrections sit in the rules they belong to; these stay open.

| | Question | Position |
| --- | --- | --- |
| **Q8, restated** | Yielding a borrowed item | Q8 above is both narrower and larger than its row. Narrower: at function level a `for(xs, x => …)` item over a `&ArrayList(i32)` parameter is returned today, in two forms (seed v0.2.80); E0912 is for a by-value source, which is right, and for the closure body (Q12). Larger: under Q8 the delegation idiom `for(sub, v => yield(v))` works for owned items only, so two borrowing generators cannot compose, and none of the eight E-b tasks yields a reference (§1's `flatten` yields `x.*`, a copy). Either a G-1 prerequisite (the element's origin forwards through `for(&xs, x => …)`) or a ninth task, `flatten : &ArrayList(ArrayList(String)) -> Impl(Iterator(Item := &String))`, with its first-attempt rate in §9.3's table |
| **Q11** | A repair G6 rejects: box the source | `src := Box.new(text); for(&src.*, …)` is rejected because the borrow's origin names the local `src`, though its target is the heap and the frame may move. It is the general repair for an owned source: it needs neither an owning iterator nor an index walk, the two §2 lists. It costs one origin rule (a borrow behind a `Box` local may cross a `yield`; the handle and the borrow are fields of one frame and drop newest first). Price it before E-b: a rejected row here with its reason, or repair 3 in §2 |
| **Q12** | The rule a `gen` body's captures follow | G7 says a borrowing future's. A closure's differs today for a `{ xs }` capture of a reference parameter: [`issues/2026-11-29-a-capture-list-closure-copies-the-referent-of-a-shared-reference-it-captures-by-value.md`](../../issues/2026-11-29-a-capture-list-closure-copies-the-referent-of-a-shared-reference-it-captures-by-value.md). G-1's gate carries §1's `flatten` as a positive control on a real build |
| **Q13** | The async half | Q9 stands, and §0's "generators add no colour of their own" is true of the sync half: an async generator is a `Stream`. G-6 needs a decision point of its own. Until it lands, an I/O-bound lazy sequence is a blocking reader in a sync `gen` body, its failures `Result` items under G14 |
| **§8's exception** | The five stable-module iterators | Converting them needs the maintainer to grant an exception to the additive-only rule, by name. Until then §8 counts four |

## 12. Measuring the cost of colouring

§0's reopening condition is made measurable by one script, run on every release and reported on the roadmap.

A **colour twin** is one higher-order operation that std exports in more than one colour.

| Count | Definition | `bab404f2e` |
| --- | --- | --- |
| **T_sa** | combinator names defined both in the blanket impls over `Iterator` and over `Stream` | 7 of 25 (`collect`, `filter`, `filter_map`, `for_each`, `map`, `skip`, `take`); 201 lines on the two sides |
| **T_f** | a name whose callback returns a `Result`, beside a sibling whose callback does not | 0 |
| **T_m** | a module under both `std/sync` and `std/async` with the same exported type | 2 (`channel`, `mutex`); 2,101 lines |
| **B** | written-out stream loops (`io.await(s.next(io), io)` in a `while`) outside std | `src/` 0, `tests/` 24; the example repositories not yet counted |

- **The script.** `scripts/census-colour-twins.py`, from the prototype `v97-probes/census/colour_twins.py`. The prototype guesses T_f from `try_` and `_exn` prefixes and three of its hits are non-blocking lock variants, so the real one reads signatures from `yo context`'s index.
- **The baseline** is taken at the first release that has both E-3 and AFA-7: E-3 deletes the `_exn` twins and AFA reshapes `Stream`.
- **The trigger (*Judgment*; the maintainer's to set):** the scope of §0 is reopened if, within six releases of the baseline, T_sa + T_f more than doubles, or the twin lines outside the two module pairs pass 1,500, or B in the example repositories grows in three consecutive releases.
- **What generators do to it.** They remove no twin; they make one cheap. An adapter written as a generator is a body of a few lines where it is a struct and an impl today, so lines per twin should fall after G-4.
