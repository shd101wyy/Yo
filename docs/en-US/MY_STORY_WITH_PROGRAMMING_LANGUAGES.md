# My Story with Programming Languages

The first programming language I ever learned was [Java](<https://en.wikipedia.org/wiki/Java_(programming_language)>). I was 16 years old, it was 2010, and I took the introductory CS course in high school. To be honest, that course almost pushed me away from programming forever. I couldn't even understand how a `for` loop worked. The simple "hello world" program was already a nightmare:

```java
public class HelloWorld {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}
```

I couldn't understand what `static` meant, why we needed `void`, or what `String[] args` was for. Why couldn't I just write `println("Hello, World!");` instead of `System.out.println("Hello, World!");`? Java made me feel like programming was an elaborate prank played on beginners.

Later, when I started applying for universities, I tried to pick up programming again for AP exams. Luckily, I had bought an iPad (first generation, 32 GB — the one that could double as a cutting board), and I discovered [MIT OCW (OpenCourseWare)](https://ocw.mit.edu/) available for free online. I don't remember the exact course name now, but the assignment involved programming a robot to move around a grid in `Java`. Something clicked. I was fascinated by the idea of controlling a robot with code, and I finally understood how programming worked. I was hooked. Object-oriented programming blew my mind, data structures and algorithms were genuinely interesting, and I wanted to learn everything.

In the winter of 2011, after finishing my university applications, I went back to my hometown for winter break. I only brought my iPad. This time, I tried to learn `C`. I installed Windows 3.1 on my iPad using an emulator, which shipped with a Turbo C compiler. Yes — Windows 3.1, on an iPad, in 2011. Peak engineering. I was amazed by how fast `C` compiled and ran compared to `Java`. I also found it fascinating that `C` let me control memory directly. Pointers! I still remember how excited I was when I wrote a matrix multiplication program. It compiled, it ran, it got the right answer. Life was good.

![Turbo C](https://www.thecrazyprogrammer.com/wp-content/uploads/2013/01/Download-Turbo-C-for-Windows-7-10-11-3264-Bit.png)

After that, I found a book called "Artificial Neural Networks" (if I remember correctly). It was an old book. Following it, I tried to implement different types of neural networks in [Python](https://www.python.org/). I was amazed by how easy `Python` was to write compared to `C` and `Java`. You don't even need a `main` function! I could finally write hello world in one line:

```python
print "Hello, World!"
# Yes, I'm Python 2, not Python 3 :)
```

I built a rather silly Python library called [PyNeuron](https://github.com/shd101wyy/pyneuron) back in 2012, following the book. It was a fun project, and I learned a lot about neural networks and `Python` in the process. That was also when I first tried Ubuntu 12.04 — my first taste of Linux. Setting up a programming environment on Linux was so much easier than on Windows. The command line felt like a superpower. I also discovered Git around this time and started using it for everything.

After I got a university offer, my father bought me a MacBook Pro Retina (2012). I installed Xcode on it, and tried to run `Python` on my iPhone 4. That's when I encountered `Objective-C`. It was like `C`, but with extra steps... and lots of square brackets. Today, all I remember is writing a lot of `retain` and `release`. Nothing more. But I did manage to port `Python` to run on my iPhone by linking some static libraries. Seeing my code run on my phone felt magical.

After I started university, I learned even more programming languages. `C++` for data structures and algorithms. `Python` for data science and machine learning. More `C` for systems programming and embedded systems. In my freshman year, I tried to build a programming language of my own. I called it [Walley](https://github.com/shd101wyy/Walley0.0) (version 0.0). The name came from the movie "[Wall-E](https://en.wikipedia.org/wiki/WALL-E)" — I wanted my programming language to be capable of building a robot like Wall-E. (Ambitious? Maybe. Delusional? Definitely.) I implemented a lexer, parser, and interpreter in `C`. Since I hadn't studied programming languages or compilers yet, it was a pretty naïve implementation.

![Wall-E](https://github.com/user-attachments/assets/22b4d1c6-e970-4403-ada9-866489832f33)

While researching how to improve Walley, I stumbled upon [Scheme](https://www.scheme.org/), a dialect of `Lisp`. It was completely different from anything I'd used before. I was fascinated by how simple and beautiful `Scheme` was. The S-expression was so elegant! I could feel the zen of `Lisp`: _Code is data, and data is code._ It was hard to imagine a programming language could be that flexible! Following that trail, I found [SICP](https://web.mit.edu/6.001/6.037/sicp.pdf), which gave me a deep understanding of recursion — especially tail-call optimized recursion. Implementing a differential equation solver in `Scheme` in just a few lines felt like wizardry. And `call/cc`? That's basically time travel.

```scheme
(define (factorial n acc)
  (if (= n 0)
      acc
      (factorial (- n 1) (* n acc))))
```

Inspired by `Scheme`, I implemented a Lisp dialect in `C` and called it [WalleyLanguage](https://github.com/shd101wyy/WalleyLanguage). The lexer and parser were much easier this time thanks to S-expressions. I also built a simple VM for it, inspired by [Lua](https://www.lua.org/) — another beautifully simple language that I'd used during a game development hackathon in my university's ACM club. I borrowed Lua's heap-based VM design. WalleyLanguage used reference counting, but didn't handle circular references. So it had a memory leak problem, which I blissfully didn't notice until much later when I learned about tracing garbage collection. Ignorance was bliss.

As I fell deeper into the `Lisp` rabbit hole, I started exploring [Clojure](https://clojure.org/) and [Common Lisp](https://common-lisp.net/). I also started using [Emacs](https://www.gnu.org/software/emacs/) as my editor, because it uses `Emacs Lisp` as its extension language. Throughout college, I used `Emacs` exclusively and never touched `Vim`. Why? Because Emacs uses Lisp! (This was a perfectly rational decision and I will not be taking questions.) I was also lucky that my university's "Programming Languages and Compilers" course used `Scheme` for assignments. I got an A+ — shocking absolutely no one who had watched me obsess over parentheses for two years.

One day, I tried to run a Java Applet in my browser and found it painfully hard. I knew [JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript) existed but had never tried it. I gave it a shot, and discovered I could just open a browser console and type `alert("Hello, World!")` to get a popup. No classes, no `public static void main`, no `System.out.println`. Just vibes. I started learning more `JavaScript`, partly because I'd heard people call it "another dialect of Scheme." (A generous characterization, but I'll take it.) The prototype-based object system was intriguing but confusing — until I discovered [io](https://iolanguage.org/).

![Java Applet](https://media.geeksforgeeks.org/wp-content/cdn-uploads/20211004162124/HelloWorldApplet.jpg)

`io` is a delightfully minimal language. Everything is a message send. There are no keywords. Even `if` and `for` are just functions:

```io
if(a == 1, writeln("a is 1"), writeln("a is not 1"))

for(i, 1, 10, write(i, " "))
// -> 1 2 3 4 5 6 7 8 9 10
```

From `io`, I finally understood how prototype-based object systems work — it's just a chain of delegations. I added a prototype-based object system to my `Walley` language, and it was so much easier to implement than class-based OOP.

Then I wanted to bring `Walley` to the web. I implemented [Walley0.1](https://github.com/shd101wyy/Walley0.1), [Walley0.2](https://github.com/shd101wyy/Walley0.2), and [Walley0.3](https://github.com/shd101wyy/Walley0.3) in `JavaScript`. As I built these versions, my understanding of `JavaScript` deepened. Node.js was just getting popular, and it was cool that we could use one language for both frontend and backend.

In 2014, the `Atom` editor was released. I was taking algorithms courses and found writing LaTeX painfully slow compared to Markdown. But I still needed LaTeX math rendering. On `Atom`, there was a package called [markdown-preview-plus](https://github.com/atom-community/markdown-preview-plus), but it didn't support scroll sync (if I remember correctly). So I built my own: [markdown-preview-enhanced](https://github.com/shd101wyy/markdown-preview-enhanced). Atom's official package development used [CoffeeScript](https://coffeescript.org/), a language that compiles to `JavaScript`. `CoffeeScript` had Python-like indentation and a lot of syntactic sugar — arrow functions, classes, list comprehensions, destructuring. It was much more concise than the `JavaScript` of that era, which didn't yet have `let`, `const`, arrow functions, or classes.

![Atom](https://media.geeksforgeeks.org/wp-content/uploads/20200526090632/1406-4.png)

As `markdown-preview-enhanced` grew in popularity, another editor appeared: Visual Studio Code. Someone asked me to build a VS Code version. I was hesitant — maintaining two codebases sounded terrible. But it was a good opportunity to learn [TypeScript](https://www.typescriptlang.org/), a superset of `JavaScript` with static types. VS Code encouraged TypeScript while Atom used CoffeeScript. I decided to rewrite the Atom version in TypeScript too. Great decision. Having types made the code so much more maintainable. I started using `TypeScript` for everything and never looked back.

In 2015, I took Computer Graphics and Virtual Reality courses, which used [C#](<https://en.wikipedia.org/wiki/C_Sharp_(programming_language)>) with `Unity`. `C#` looked a lot like `Java` but felt different in subtle ways. I was also playing a lot of [Minecraft](https://www.minecraft.net/en-us), so naturally I spent way too much time trying to clone it in `C#` and `Unity`. Today, I mostly remember that `C#` looked a lot like `Java`. That's about it.

That summer, I interned at [Zhihu](https://www.zhihu.com/), a Chinese Q&A site similar to Quora. I used `JavaScript`, `TypeScript`, and `Python` there — learning React, Angular, and the Tornado web framework along the way. It was also where I first encountered [Go](https://golang.org/). `Go` was refreshingly simple. Goroutines and channels made concurrent programming feel natural — a far cry from JavaScript's callback spaghetti. The standard library was excellent for building web servers. And the performance was comparable to `C` in some cases. Good times.

In 2016, I used more `C++` for compiler courses involving [LLVM](https://llvm.org/). Ironically, I barely remember `C++` now since I haven't touched it since. I also took a course where someone demonstrated building a voting app on Ethereum in [Solidity](https://www.soliditylang.org/) — my first exposure to blockchain. But when I heard you had to _pay_ to deploy a smart contract, I quietly backed away. Things changed after I graduated in 2017, when I somehow ended up in the web3 industry and learned `Solidity` properly. During that time, I also discovered `Rust` — a language that genuinely rewired my brain. The ownership model was unlike anything I'd seen. Memory safety without a garbage collector! But fighting the borrow checker was painful, and lifetimes took me a long time to internalize. Zero-cost abstractions and safety guarantees were worth it though.

In 2019, I joined a startup with a college friend in Shenzhen, China. We were building AI products that helped salespeople find potential leads and investors find opportunities. We chose [Flutter](https://flutter.dev/) for cross-platform mobile and web development. Flutter uses `Dart`, which feels like `TypeScript` but with types written before the variable name (`int x` instead of `x : int`). The language didn't surprise me the way Lisp, JavaScript, and Rust had. Sometimes a tool is just a tool.

In 2020, I returned to my previous company and discovered they'd replaced [PHP](https://www.php.net/) with [Haskell](https://www.haskell.org/) for the backend, [PureScript](https://www.purescript.org/) for the frontend, and [Nix](https://nixos.org/) for DevOps. I'd heard of Haskell for years but never tried it — the concept of `Monad` had kept `>>=` pushing me away. However, once I was forced to use it for work, monads suddenly made a lot of sense. I also developed a deeper understanding of [Functors, Applicatives, and Monads](https://www.adit.io/posts/2013-04-17-functors,_applicatives,_and_monads_in_pictures.html). `PureScript` was very similar to `Haskell` but compiled to `JavaScript`. My functional programming skills improved dramatically during that period. On the DevOps side, `Nix` is more of a declarative configuration language. Since then, I've used it for all my projects and even manage my OS and home configuration with [home-manager](https://github.com/nix-community/home-manager).

![Functor, Applicative, Monad](https://www.adit.io/imgs/functors/recap.png)

In 2023, my wife was pregnant. I decided to build something to commemorate my child. So... why not a programming language? (As one does.)

Over the previous years, I'd read the [Rust book](https://doc.rust-lang.org/book/) again and again, trying to fully grasp ownership and the borrow checker. One day, I found [Austral](https://austral-lang.org), a language that uses Linear Types for memory safety. Its [borrow checker](https://austral-lang.org/tutorial/borrowing) based on regions was much easier to understand than Rust's. I decided to build a similar language with Linear Types. I called it [Mo](https://github.com/shd101wyy/Yo/commit/56eeb6841fadd08afa8c332b6377d34f87168914), because it was easy to pronounce and remember — and I wanted to give my child the nickname "Momo." I chose `TypeScript` (the language I used most often) for prototyping and decided to transpile to `C`.

However, during development, `Mo` started looking more and more like `Rust`. That wasn't the plan. I wanted its syntax to be easy to parse, like `Lisp`, with a simple AST that would make a macro system straightforward. But I didn't want literal S-expressions — integrating a type system with S-expressions felt awkward. Existing approaches like [Typed Racket](https://docs.racket-lang.org/ts-guide/quick.html) and Clojure's [core.typed](https://github.com/clojure/core.typed) didn't look natural. And let's be honest — S-expressions without careful formatting descend into parentheses purgatory:

![](https://andreyor.st/2020-12-03-we-need-to-talk-about-parentheses/how-to-save-the-princess-in-lisp.jpg)

I found [Elixir](https://elixir-lang.org) online and smelled `Lisp` in its macro system. Its syntax was clean and simple. I decided to combine `Elixir`'s style with `io`'s philosophy that everything is a function. In `Elixir`, you can write functions with or without parentheses — both `add(1, 2)` and `add 1, 2` are valid. This made `io`-style control flow look more natural without parentheses:

```io
if a == 1,
  writeln("a is 1"),
  writeln("a is not 1")

// The ',' is still needed, just the parentheses are optional now.
```

Nice. But there was another problem: operator precedence. `1 + 3 * 4` doesn't fit well with the function-call syntax model. The parser would still need special logic for precedence. Unlike `(+ 1 (* 3 4))` in Lisp, which is straightforward. I spent a while stuck on this, until `Austral`'s [Anti-features](https://austral-lang.org/features) list inspired me:

> - No arithmetic precedence.
>
> Just as with arithmetic, there is no operator precedence for logical operators in Austral: any expression beyond one level has to be fully parenthesized:
>
> ```austral
> -- Not valid:
> a and b and c and d
> -- Valid:
> a and (b and (c and d))
> ```

We don't need operator precedence! Just require explicit parentheses. So `1 + 2 + 3` in `Mo` has to be `(1 + 2) + 3` or `1 + (2 + 3)`. A bit more verbose, but dramatically simpler to parse and more consistent. A good trade-off.

With the syntax settled, I was feeling great about `Mo`. Then I read [Algebraic Effects for the Rest of Us](https://overreacted.io/algebraic-effects-for-the-rest-of-us/), and my mind was blown again. Algebraic effects offered a more composable approach to managing side effects than monads. I found [Koka](https://koka-lang.github.io/koka/doc/index.html), [Eff](https://www.eff-lang.org/), [Effekt](https://effekt-lang.org/), [Ante](https://antelang.org/), and [Unison](https://www.unison-lang.org/) — all beautiful. I wanted to add algebraic effects to `Mo`, but implementing effect handlers in a language that transpiles to C with manual memory management via Linear Types proved extremely difficult. So I paused.

I also found that implementing a borrow checker for `Mo` was harder than expected. Austral's approach was limiting in some cases. I looked at [Hylo](https://hylo-lang.org/), which uses [Mutable Value Semantics](https://arxiv.org/abs/2106.12678) for memory safety — essentially [Second-Class References](https://borretti.me/article/second-class-references). No borrow checker needed, at the cost of some flexibility. I tried it in `Mo`, and it was much easier to implement.

But second-class references had their own limitations — iterators, for instance, were painful. I began to accept that language design is fundamentally about trade-offs. You can't have everything. It's like choosing a car: you can pick the sports car that's fast but impractical, or the minivan that hauls groceries but won't win races. (Or you can spend years building your own car in a garage. Guess which one I picked.)

I wanted a statically typed language, like `TypeScript`. No more dynamic typing. But could we go further — make types first-class citizens? I found [Idris](https://www.idris-lang.org/), which supports first-class types but is quite high-level like Haskell. Any systems language with first-class types? Yes — [Zig](https://ziglang.org/)! Its `comptime` feature was incredibly cool, allowing compile-time code execution. I also learned about [Odin](https://odin-lang.org/) and [Jai](https://jai-lang.org/), which have similar capabilities.

My angel baby came into the world in May 2024. My wife gave her the nickname 柚子 (Yuzu) — a kind of citrus fruit. Sweet, refreshing, and perfect. I renamed my programming language from `Mo` to `Yo` (柚), to match.

I decided to make `Yo` simple — as easy to use as its name is to say. I removed Linear Types, the Borrow Checker, and Second-Class References. I also realized that algebraic effect handlers could be approached differently — through dependency injection and implicit parameters, like in [Scala](https://www.scala-lang.org/).

This raised the big question: how do we manage memory safely without all that complexity? If not manual management (like `C` and `Zig`), we need either a tracing GC (`Lua`, `Go`, `JavaScript`) or reference counting (`Swift`). Both have drawbacks. GC can stop the world; reference counting can't handle cycles natively and atomic RC has overhead. Non-atomic RC is cheaper, but multi-threading becomes a problem. Trade-offs everywhere.

I researched how other languages handle this. [Nim](https://nim-lang.org/) uses non-atomic RC with a cycle detector. [Swift](https://swift.org/) uses atomic RC with weak pointers to break cycles (like `C++` and `Rust`). There's also [Generational References](https://verdagon.dev/blog/generational-references) from [Vale](https://vale.dev/), and ["single ownership"](https://docs.inko-lang.org/manual/latest/getting-started/memory-management/) from [Inko](https://inko-lang.org/).

I basically tried all of them — including the [tri-color tracing GC](https://en.wikipedia.org/wiki/Tracing_garbage_collection#Tri-color_marking) used by `Go`, and [biased reference counting](https://dl.acm.org/doi/10.1145/3243176.3243195) used in Python 3.14 to eliminate the [GIL](https://wiki.python.org/moin/GlobalInterpreterLock). But they all introduced extra runtime overhead and complexity. I wanted simplicity and determinism.

In the end, I chose non-atomic reference counting with a cycle collector based on [QuickJS](https://medium.com/@landerlyoung/anatomy-of-quickjs-garbage-collection-algorithm-fc02f6813ba1)'s approach — the same strategy as `Nim`. I also brought in compile-time reference counting from [Lobster](https://strlen.com/lobster/) to eliminate as many RC operations as possible at compile time. The author of Lobster also [inspired me](https://github.com/aardappel/lobster/issues/374) on handling multi-threading with non-atomic RC. The approach is similar to JavaScript's [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers) model — and it makes sense.

In 2025, vibe coding became a thing. With LLM assistance, `Yo`'s development accelerated dramatically. Hard problems that had stumped me — like implementing a state machine for async/await, or one-shot delimited continuations for effect handlers that work in `C` with Yo's memory model — suddenly had solutions.

`Yo` absorbs ideas from every programming language I've encountered along the way. It's a distillation of the good ideas I've collected over 15 years of hopping between languages. It's still in its early stages, with many features to add and refine. But I'm excited about where it's going, and I hope it can be useful to others too.

I feel like I've regained the passion I had when building `Walley` and `Markdown Preview Enhanced`. To build something great, you need to be its user and enjoy using it. That's my story with programming languages. I'll end with a piece of code from my `WalleyLanguage` that I wrote years ago:

```lisp
(def a-life (Life:clone))
(while (eq? (a-life:get-state) 'alive)
    (print "I have a new Plan!")
    (let a-plan (Plan:clone)
        (while (not (a-plan:succeed))
            (a-plan:struggle)
            (if (eq? 'fail (a-plan:get-state))
                (print "Come on!")))
        (print "What A Beautiful Day!")))
(print "No Regrets.")

;; 生命是一段漫长的旅程。
;; 想了，就去做。
;; 输了，从头再来。
;; 摔了，爬起来继续。
;; 赢了，还要再往前走。
;; 死了，没留下任何遗憾。
```

By Yiyi,
For Yo: https://github.com/shd101wyy/Yo
March 2026
