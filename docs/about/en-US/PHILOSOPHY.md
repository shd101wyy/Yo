# Philosophy and Inspiration

**Yo** is a multi-paradigm, general-purpose, compiled programming language.
Yo aims to be **Simple** and **Fast**: it compiles to C11, and the goal is
speed comparable to C. The measured gap is in
`plans/backlog/CODEGEN_PERFORMANCE.md`.

**Yo** aims to be a simple to learn programming language for C and JavaScript (TypeScript) programmers 😉.

Our goal is to be a practical language that is easy to use and easy to learn.

## Philosophy

**LLM-friendly to write, human-friendly to read.** The two goals
align: a snippet that an LLM can produce without scope-chain reasoning
is also a snippet a human reviewer can understand in a diff. The
design lever is _explicitness_ — every effect, parameter, and capture
is visible at the call site, so what you see is what runs.

**Key Design Principles:**

- **Simple syntax inspired by Lisp** (no keywords, minimal)
- **LLM-friendly syntax** (function, keyword, and prefix-operator calls always use immediate parentheses)
- **First-class types** (types are values)
- **Compile-time evaluation** (powerful `comptime` system)
- **Ownership and borrowing** (one owner per value, a move at the last use, `&T`/`&mut T` references checked at compile time; `Rc`/`Arc` for explicit sharing)

**A few NO design choices:**

- **No operator precedence** (same-operator chains left-associate; adjacent different operators require explicit parentheses)
- **No variable shadowing** (similar to Zig)
- **No garbage collector** (reference counting frees every cell at its last handle; a reference cycle leaks unless a `Weak` breaks it, as in Rust)

## Inspiration

The **Yo** language is inspired by the following programming languages and absorbs some of their good ideas:

- Lisp
  - [Scheme](https://www.scheme.com/)
  - [Clojure](https://clojure.org/)
- [C](https://www.c-language.org/)/[C++](https://isocpp.org/)
- [Rust](https://www.rust-lang.org/)
- [Haskell](https://www.haskell.org/), [OCaml](https://ocaml.org/), [PureScript](https://www.purescript.org/), [Scala](https://www.scala-lang.org/)
- [JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript), [TypeScript](https://www.typescriptlang.org/)
- [Jai](https://github.com/Ivo-Balbaert/The_Way_to_Jai), [Zig](https://ziglang.org/), [Odin](https://odin-lang.org/)
- [Koka](https://koka-lang.github.io/), [Effekt](https://effekt-lang.org/), [Flix](https://flix.dev/)
- [Nim](https://nim-lang.org/)
- [Dafny](https://dafny.org/)
- [Austral](https://austral-lang.org/)
- [Elixir](https://elixir-lang.org/)
- [Io](https://iolanguage.org/)
- [ATS](https://www.ats-lang.org/)
- [Go](https://go.dev/)
- [Ada](https://www.adacore.com/)
- [hylo](https://www.hylo-lang.org/)
- [Lobster](https://aardappel.github.io/lobster/README_FIRST.html)
- [pony](https://www.ponylang.io/)
- [Swift](https://swift.org/)
- [Vale](https://vale.dev/)

## References

- [Ocaml Locality](https://blog.janestreet.com/oxidizing-ocaml-locality/)
- [Data race freedom](https://github.com/ocaml-flambda/ocaml-jst/blob/main/jane/doc/proposals/data-race-freedom.md)
- [ICFP'21 Tutorials - Programming with Effect Handlers and FBIP in Koka](https://www.youtube.com/watch?v=6OFhD_mHtKA&ab_channel=ACMSIGPLAN)
- [Simply Easy! An Implementation of a Dependently Typed Lambda Calculus](http://strictlypositive.org/Easy.pdf)
- [Reconstructing TypeScript](https://jaked.org/blog/2021-09-07-Reconstructing-TypeScript-part-0)
- [PureScript Types](https://github.com/purescript/documentation/blob/master/language/Types.md)
- [The Ultimate Conditional Syntax](https://icfp22.sigplan.org/details/mlfamilyworkshop-2022-papers/6/The-Ultimate-Conditional-Syntax)
- [Algebraic Effects for the Rest of Us](https://overreacted.io/algebraic-effects-for-the-rest-of-us/)
- [What Color is Your Function](https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/)
- [Implementing Algebraic Effects in C "Monads for Free in C"](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/06/algeff-in-c-tr.pdf)
- [Efficient Compilation of Algebraic Effect Handlers - Ningning Xie](https://www.youtube.com/watch?v=tWLPrPfb4_U&ab_channel=ETHWSCR)
- [Generalized Evidence Passing for Effect Handlers](https://www.microsoft.com/en-us/research/uploads/prod/2021/03/multip-tr-v4.pdf)
- [Structured Asynchrony with Algebraic Effects](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/05/asynceffects-msr-tr-2017-21.pdf)
- [Effects as Capabilities: Effect Handlers and Lightweight Effect Polymorphism](https://dl.acm.org/doi/pdf/10.1145/3428194)
- [A Typed Continuation-Passing Translation for Lexical Effect Handlers](https://se.cs.uni-tuebingen.de/publications/schuster22typed.pdf)
- [Zero-cost Effect Handlers](https://se.cs.uni-tuebingen.de/publications/schuster19zero.pdf)
- [Why Rust Closures are (Somewhat) Hard](https://stevedonovan.github.io/rustifications/2018/08/18/rust-closures-are-hard.html)
- [Inside Rust's Async Transformation](https://blag.nemo157.com/2018/12/09/inside-rusts-async-transform.html)
- [Coroutines: Suspending State Machines](https://medium.com/google-developer-experts/coroutines-suspending-state-machines-36b189f8aa60)
- [What's the difference between an algebraic effect, a callback function, and a coroutine](https://www.reddit.com/r/ProgrammingLanguages/comments/13v35fk/whats_the_difference_between_an_algebraic_effect/)
- [Revisiting coroutines](https://dl.acm.org/doi/abs/10.1145/1462166.1462167)
- [One-shot Algebraic Effects as Coroutines](http://logic.cs.tsukuba.ac.jp/~sat/pdf/tfp2020.pdf)
- [Implementing Co, a Small Language With Coroutines](https://abhinavsarkar.net/posts/implementing-co-3/)
- [Retrofitting Effect Handlers onto OCaml](https://arxiv.org/pdf/2104.00250.pdf)
- [Do Be Do Be Do](https://arxiv.org/pdf/1611.09259.pdf)
- [Custom Infix Operators in Haskell](<https://bugfactory.io/blog/custom-infix-operators-in-haskell/#:~:text=Precedence%20(aka%20Operator%20Binding)&text=All%20operators%20in%20Haskell%20have,6%20>).)
- [Region-Based Memory Management in Cyclone](https://www.cs.umd.edu/projects/cyclone/papers/cyclone-regions.pdf)
- [Implementation Strategies for Mutable Value Semantics](https://www.jot.fm/issues/issue_2022_02/article2.pdf)
- [Type Classes as Objects and Implicits](https://citeseerx.ist.psu.edu/document?repid=rep1&type=pdf&doi=d30d65ca9ce7891352024a5c71ebe0ae8c41f7ac)
- [Implicit Parameters: Dynamic Scoping with Static Types](https://dl.acm.org/doi/pdf/10.1145/325694.325708)
- [Scrap your type classes](https://www.haskellforall.com/2012/05/scrap-your-type-classes.html)
- [Implicit Parameters in Scala and Haskell](https://trebledj.me/posts/implicit-parameters-in-scala-and-haskell/)
- [High-level effect handlers in C](https://homepages.inf.ed.ac.uk/slindley/papers/libseff-draft-november2023.pdf)
- [Exceptions in C with longjmp and setjmp](https://web.archive.org/web/20091104065428/http://www.di.unipi.it/~nids/docs/longjump_try_trow_catch.html)
- [Continuation Passing for C](https://www.irif.fr/~jch/cpc.pdf)
- [Refinement Types for TypeScript](https://goto.ucsd.edu/~pvekris/docs/pldi16.pdf)
- [Continuations and Delimited Control
  ](https://okmij.org/ftp/continuations/)
- [Custom allocators in Rust](https://nical.github.io/posts/rust-custom-allocators.html)
- [Ownership You Can Count On: A Hybrid Approach to Safe Explicit Memory Management](https://inko-lang.org/papers/ownership.pdf)
