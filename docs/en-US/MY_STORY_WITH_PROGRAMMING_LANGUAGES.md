# My Story with Programming Languages

The first programming language that I learnt was [Java](<https://en.wikipedia.org/wiki/Java_(programming_language)>). I was 16 years old back then in 2010, and took the course in my high school. To be honest, this CS intro course in high school almost pushed me away from programming. I couldn't even understand how the `for` loop worked. The simple "hello world" program was already a nightmare for me:

```java
public class HelloWorld {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}
```

I couldn't understand what `static` meant, why we needed `void`, and what `String[] args` was for. Why can't I just wrote `println("Hello, World!");` while I had to write something like `System.out.println("Hello, World!");` I felt like programming was just too complicated for me.

Later on, when I started applying for universities, I tried to pick up programming again for AP exams. Luckily, I bought an iPad first generation 32GB, and I found the [MIT OCW (OpenCourseWare)](https://ocw.mit.edu/) available for free online. I started watching the course. I don't remember the course name now, but I remember the assignment was about programming a robot to move around a grid in `Java`. I was so fascinated by the idea of controlling a robot with code, and I finally understood how programming worked. I was hooked. I was also intrigued by the idea of object oriented programming, and I started learning more about it. I also started learning about data structures and algorithms, and I found them really interesting. I was amazed by how powerful programming could be, and I wanted to learn more.

In the Winter of 2011, after finishing application to university, I went back to my hometown for the winter break. I only brought my iPad with me, and I continued learning programming. This time, I tried to learn `C`. I installed Windows 3.1 on my iPad using an emulator, which ships with a Turbo C compiler. I was so excited to write my first `C` program, and I was amazed by how fast it compiled and ran compared to `Java`. I also found it interesting that `C` was a lower level language than `Java`, and I could control the memory directly. I started learning about pointers, and I found them really fascinating. I still remember how excited I was when I write a matrix multiplication program in `C`. It was cool.

![Turbo C](https://www.thecrazyprogrammer.com/wp-content/uploads/2013/01/Download-Turbo-C-for-Windows-7-10-11-3264-Bit.png)

After that, I found a book called "Artificial Neural Network" (If I remember correctly.). It was an old book. Following book, I tried to implement different types of neural networks in [Python](https://www.python.org/). I was amazed by how easy `Python` was to write compared to `C` and `Java`. You don't even need to define a `main` function in `Python`. I can finally write hello world in one line:

```python
print "Hello, World!"
# Yes, I am python 2, not python 3 :)
```

I built a quite silly Python library called [PyNeuron](https://github.com/shd101wyy/pyneuron) back in 2012, following the book. It was a fun project, and I learned a lot about neural networks and `Python` in the process. That was also the first time I tried with Ubuntu 12.04. It's the first time I used Linux, and I found it very interesting. It is a lot easier to set up a programming environment in Linux than in Windows. I also found the command line interface in Linux very powerful, and I started learning how to use it. I also started learning about version control systems, and I found Git really useful. I started using Git for all my projects, and I found it really helpful for managing my code.

After I got a university offer, my father bought me a MacBook Pro Retina (2012). I installed XCode on it, and I tried to run `Python` on my iPhone 4. That's the time I tried with `Objective-C`. It's quite like `C`, but with many other features. Today, I only remember I wrote quite some `retain` and `release` in my code. Nothing more. But luckily I finally ported `Python` to run on my iPhone. I still remember I linked some static libraries to make it work, and I was so excited when I finally got it running. It was a great feeling to see my code running on my phone.

After I got into university, I started learning more programming languages. I learnt `C++` for data structures and algorithms courses. I learnt `Python` for data science and machine learning courses. I learnt more `C` in system programming courses and embedded systems. In my freshman year, I tried to build a simple programming language on my own. I called it [Walley](https://github.com/shd101wyy/Walley0.0) language (version 0.0). Its name came from the movie "[Wall-E](https://en.wikipedia.org/wiki/WALL-E)". I wanted my programming language to be able to build a robot like Wall-E. I implemented lexer, parser, and interpreter in `C`. As I haven't learnt about programming langauge and compiler yet, it was quite a dummy implementation.

![Wall-E](https://github.com/user-attachments/assets/22b4d1c6-e970-4403-ada9-866489832f33)

Later on, I continued learning the idea of programming languages, trying to enrich the features of my Walley language. During researching online, I found an interesting programming language called [Scheme](https://www.scheme.org/), which is a dialect of `Lisp`. It's completely different from the programming languages that I used before. I was fascinated by how simple and beautifule `Scheme` is. The S expression was so elegant! I can feel the zen in the philosophy of `Lisp`: Code is data, and data is code. Beautiful! It's hard to imagine a programming language could be flexible like that! Following the track, I found the book called [SICP](https://web.mit.edu/6.001/6.037/sicp.pdf), which systematically introduced `Scheme` and how to construct a program with it. It was also the first time I had a deep understanding on how the recursion, especially tail call optimized recursion works. It was also so cool that I could implement a differential equation solver in `Scheme` with just a few lines of code. The `call/cc` is like some kind of time travel.

```scheme
(define (factorial n acc)
  (if (= n 0)
      acc
      (factorial (- n 1) (* n acc))))
```

I was amazed by the power of `Scheme`. So I tried to implement a Lisp dialect myself in `C`. This time, I called it [WalleyLanguage](https://github.com/shd101wyy/WalleyLanguage). It's still `Walley`, but this `Walley` is a lot easier to implement its lexer and parser, as it used S expression. I also implemented a simple VM for it. The idea of the VM comes from [Lua](https://www.lua.org/), which I used in an ACM club game development hackathon. `Lua` is another simple and elegant programming language. I used its idea of heap-based VM to implement my own VM for WalleyLanguage. It was a fun project, and I learned a lot about programming languages and compilers in the process. The `Walley` language uses reference counting, but didn't handle circular references. So it has a memory leak problem, which I didn't really notice until later on I learnt about the difference between reference counting and tracing garbage collection.

As I was intriguied by `Lisp`, I started learning other lisp dialects like [Clojure](https://clojure.org/) and [Common Lisp](https://common-lisp.net/). They were all very fun. I also started using [Emacs](https://www.gnu.org/software/emacs/) as my code editor, because it uses `Emacs Lisp` as its extension language. During my college I used `Emacs` only and never used the `Vim`, because `Emacs` uses `Lisp`! And I was so lucky that the "Programming Languages and Compilers" course in my university used `Scheme` as the programming language for assignments. I got an `A+` for the course in the end.

One day, I was trying to run `Java` Applet in my browser, and I found it very very hard to use. I know there is [JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript) but I have never tried it before. I decided to give it a try, and I found it is very easy to use it in browser. I can open a browser console, and simply typing `alert("Hello, World!")` will pop up a dialog box with "Hello, World!" in it. It was so cool! I started learning more about `JavaScript`, and I found it is a very powerful language. Another reason is I heard people saying `JavaScript` is another dialect of `Scheme`. I started building learning `JavaScript`, and I found its prototype based object system is quite interesting. However, I had a hard time trying to understand it. Until one day I found another programming language called [io](https://iolanguage.org/).

![Java Applet](https://media.geeksforgeeks.org/wp-content/cdn-uploads/20211004162124/HelloWorldApplet.jpg)

`io` is a very simple programming language. It uses prototype based object system as is core. And its syntax is as simple as Lisp in my opinion. Everything is a function. There is no keyword. From `io` I finally understand how prototype based object system works. It's like a chain of prototypes. When you try to access a property on an object, it will first look for the property on the object itself. If it doesn't find it, it will look for the property on the object's prototype. And it will keep looking up the prototype chain until it finds the property or reaches the end of the chain. It was so cool! I added the prototype based object system to my `Walley` language, and it was a lot easier to implement than the class based object system.

Then, I wanted to bring `Walley` to the web. I wanted to run it in the browser. So I implemented [Walley0.1](https://github.com/shd101wyy/Walley0.1), [Walley0.2](https://github.com/shd101wyy/Walley0.2), and [Walley0.3](https://github.com/shd101wyy/Walley0.3) in it. As I develop these `Walley`s in `JavaScript`, I got deeper and deeper understanding of `JavaScript`. Back the time, Node.js was just getting popular, and I started using it for my projects. It was cool that we could use JavaScript to build both frontend and backend.

In 2014, the `Atom` editor was released. I was taking the algorithm courses back then, and I found writing LaTeX is very hard and time consuming compared to Markdown. However, I do have need to render LaTeX math expressions. On `Atom` editor there was a package called [markdown-preview-plus](https://github.com/atom-community/markdown-preview-plus), which allows you to do that. However, it didn't support scroll sync (If I remember correctly). So I decided to build a package myself, called [markdown-preview-enhanced](https://github.com/shd101wyy/markdown-preview-enhanced). Back then the official `Atom` package development uses [CoffeeScript](https://coffeescript.org/), which is a language that compiles to `JavaScript`. `CoffeeScript` also uses indentation like `Python`, and it has a lot of syntactic sugar, such as arrow functions, class, list comprehensions, and destructuring assignment. I found `CoffeeScript` is a lot concise to write than the `JavaScript` back then. At that time, `JavaScript` ES6 was not released, and it didn't have `let`, `const`, arrow functions, class, and many other features.

![Atom](https://media.geeksforgeeks.org/wp-content/uploads/20200526090632/1406-4.png)

As I continued developing `markdown-preview-enhanced`, more and more people use my extension, another editor `Visual Studio Code` was released. One day I found someone asked me to develop a VS Code version of `markdown-preview-enhanced`. I was a bit hesitant at first, because I didn't want to maintain two versions of the same extension. But then I thought it would be a good opportunity to learn about [TypeScript](https://www.typescriptlang.org/), which is a superset of `JavaScript` that adds static types. VS Code suggested to use `TypeScript`, while Atom was using `CoffeeScript`. To make my life easier, I decided to rewrite the Atom version of `markdown-preview-enhanced` in `TypeScript` as well. It was a good decision, because it made the code more maintainable and easier to understand. I also found `TypeScript` is a lot better than `CoffeeScript`, because it has static types, which can catch a lot of errors at compile time. It also has better support for modern JavaScript features, such as async/await, which is very useful for my extension. During this process, I also found having types is really helpful for the code correctness and maintainability. I started using `TypeScript` for all my projects, and I found it really helpful for managing my code.

In 2015 I took the courses related to Computer Graphics and Virtual Reality, which uses [C#](<https://en.wikipedia.org/wiki/C_Sharp_(programming_language)>) and `Unity` game engine for assignments. I found `C#` looked a lot like `Java`, but in some sense quite different. At that time, I was also playing [MineCraft](https://www.minecraft.net/en-us) a lot. So I spent quite some time trying to implement a similar game in `C#` and `Unity`. But still, I only remembered it looked a lot like `Java`, but I don't remember much about it now.

In 2015 summer, I got my summer intern in a company called [Zhihu](https://www.zhihu.com/), which is a Chinese Q&A website like Quora. There I used more `JavaScript` and `TypeScript` to build the frontend of the website. I also used `Python` to build some internal tools. There I learnt about `React` and `Angular` frameworks, and `Tornado` web framework in `Python`. It was a great experience. It was also the first time I learnt about [Go](https://golang.org/), which is a programming language developed by Google. I found `Go` is a very simple and efficient language. It has a lot of features that make it easy to write concurrent programs, such as goroutines and channels. We used `Go` to develop some interal tools. I also found `Go` has a very good standard library, which makes it easy to build web servers and other network applications. The goroutine and channel model is quite cool. It's completely different from how we write async code in `JavaScript` with callbacks or promises. With goroutines and channels, we can write concurrent code in a more synchronous style, which is easier to read and maintain. I also found `Go` has a very good performance, which is comparable to `C` in some cases. It was a great experience to learn about `Go`, and I found it is a very useful language for building high performance network applications.

In 2016, I spent more time using `C++` as I took some compiler courses in university, which involves [LLVM](https://llvm.org/). Ironically I don't remember `C++` much nowadays as I haven't had a chance to use it anymore. I also took a course, but I don't remember its name, where someone demostrated writing a voting app living on top of Ethereum blockchain in [Solidity](https://www.soliditylang.org/). That was the first time I heard about blockchain and smart contract. But when I heard that I need to pay to deploy a smart contract and interact, or more precisely, write to the blockchain, I was a bit hesitant to try it out. Things changes after I graduated from university in 2017, and I somehow entered the web3 industry, where I learnt about `Solidity` more. During that time, I also learnt about `Rust`, which is another programming language that shocks my mind. `Rust` is a systems programming language that focuses on safety and performance. It has a very unique ownership model, which allows it to guarantee memory safety without using a garbage collector. I found `Rust` is a very powerful language, and it has a lot of features that make it easy to write safe and efficient code. However, fighting the borrow checker was quite a pain back the time. The concept of lifetime is also quite hard to understand for me at the beginning. But its zero-cost abstraction and memory safety are really cool.

In 2019, I joined a start up company with my college friend in Shenzhen, China. We were building some AI related products, that helps salesman to find the potential leads, and investors to find potential investment opportunities. At start we wanted to build a mobile app, and we wanted to try the most cutting-edge frontend technologoies. We chose to use [Flutter](https://flutter.dev/), which allows you to develop once and runs on both mobile and web. Flutter uses `Dart` as its programming language. I feel it is quite like `TypeScript`, but having type defined in front like `int x` but not after like `x : int`. The language didn't give me that many surprises like Lisp, JavaScript and Rust.

In 2020, I got back to work for my previous company. After I got back I noticed the company was not using [PHP](https://www.php.net/) anymore, which was the main programming language for the backend of the website. Instead, they started using [Haskell](https://www.haskell.org/) for website backend, [PureScript](https://www.purescript.org/) for frontend, and [Nix](https://nixos.org/) for devops. I had heard about Haskell before for many years, but I never had a change to try it out. The concept of `Monad` pushed `=>>` me away. However, I had to use it for work, and I eventually found the Monad made a lot of sense. I also had a deeper understand of how [Functor, Applicatives, and Monads](https://www.adit.io/posts/2013-04-17-functors,_applicatives,_and_monads_in_pictures.html) work. The `PureScript` is very similar to `Haskell`, but it compiles to `JavaScript`. Both languages share quite some similarities. I feel my functional programming abilities improved a lot during that period. On the other side, the `Nix` is more like a configuration language. It's declarative. Since then I use it for all of my projects, setting up the development environment. I also use `Nix` to manage my OS configuration and home configuration (by [home manager](https://github.com/nix-community/home-manager)) to keep everything consistent across different machines.

![Functor, Applicative, Monad](https://www.adit.io/imgs/functors/recap.png)

In 2023, my wife was pregnant. I decided to build something to commemorate my child. So how about I built a programming language! Over the past few years, I read the [Rust book](https://doc.rust-lang.org/book/) once and once again, trying to understand the ownership model and the borrow checker. One day, I found another programming language called [Austral](https://austral-lang.org), which uses Linear Types to achieve the memory safety. Its [borrow checker](https://austral-lang.org/tutorial/borrowing) based on `Region` is a lot easier to understand than Rust's. So I decided to build a similar programming language with Linear Types and borrow checker to commemorate my child. I called it [Mo](https://github.com/shd101wyy/Yo/commit/56eeb6841fadd08afa8c332b6377d34f87168914) language at start because it's easy to pronounce and remember. And I wanted to give my child the nickname `Momo`. I decided to use the language `TypeScript` that I used most opten to prototype it, and transpile it to `C`.

However, during my development, I found my programming language looks more and more like `Rust`. So I decide to change how my language looks like. I want its syntax to be easy to parse, like `Lisp`. I want a simple AST, so it could be also easy to implement macro system. However, I don't really want to use S expression in `Mo`, as I found it's hard to integrate type system with S expression. The existing ones, such as [Typed Racket](https://docs.racket-lang.org/ts-guide/quick.html) and Clojure's [core.typed](https://github.com/clojure/core.typed) don't look that natural. The most important part is that, the S expression is still not that human readable due to its parentheses hell if you don't manage to write it in a good way:

![](https://andreyor.st/2020-12-03-we-need-to-talk-about-parentheses/how-to-save-the-princess-in-lisp.jpg)

I found [Elixir](https://elixir-lang.org) language online, which is a language that runs on the Erlang VM. I smell the sense of `Lisp` in its macro system. It has very simple syntax. So I decided to change the syntax of `Mo` to be more like `Elixir`. Also, `io` language's syntax reminds me of having everything as function. In `io`, everything is a function. There is no keyword. Even the `if` and `for` loops are just functions:

```io
if(a == 1, writeln("a is 1"), writeln("a is not 1"))

for(i, 1, 10, write(i, " "))
// -> 1 2 3 4 5 6 7 8 9 10
```

Yes! That's exactly what I want for `Mo`. I decided to combine `io` and `Elixir`. In `Elixir`, we can write functions with or without parentheses. So both `add(1, 2)` and `add 1, 2` are valid. This way the `if` call in `io` could be more natural without parentheses like:

```io
if a == 1,
  writeln("a is 1"),
  writeln("a is not 1")

// The ',' is still needed, just the parentheses are optional now.
```

It looks nice. But I had another problem. How do we handle operator precedence there? `1 + 3 * 4` doesn't fit well with the function call syntax. The parser still needs extra logic to handle operator precedence. Unlike `(+ 1 (* 3 4))` in Lisp which is quite straightforward. I spent quite some time thinking about it, until one day on `Austral`'s website, its [Anti-features](https://austral-lang.org/features) list inspired me:

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

Yes we don't really need operator precedence! We can just require the user to write parentheses for every function call. It is a bit more verbose, but it is a lot easier to parse. It also makes the code more consistent, as we don't have to worry about operator precedence. So `1 + 2 + 3` in `Mo` has to be `(1 + 2) + 3` or `1 + (2 + 3)`. It is a good trade-off for the simplicity it brings.

The syntax of `Mo` is settled down. Its parser is easy. I personally is very satisfied with the new design of it. One day, I read the article [Algebraic Effects for the Rest of Us](https://overreacted.io/algebraic-effects-for-the-rest-of-us/), which introduced the concept of algebraic effects and effect handlers. I found it is a very powerful concept. It's another way to manage effects, and it is more composable than monads. I started searching for programming languages that support algebraic effects, and I found [Koka](https://koka-lang.github.io/koka/doc/index.html), [Eff](https://www.eff-lang.org/), [Effekt](https://effekt-lang.org/), [Ante](https://antelang.org/), and [Unison](https://www.unison-lang.org/). Beautiful! I decided to add algebraic effects and effect handlers to my `Mo` language. However, I found it hard to implement the effect handlers, especially when `Mo` transpiles to C and require some sort of manual memory manage using Linear Type. So I stopped there. Later on, I also found implementing borrow checker for `Mo` is also quite hard. The `Austral`'s way of borrow checker is limiting in some cases, and I started looking for some other solutions. I found [Hylo](https://hylo-lang.org/) language, which uses the [Mutable Value Semantics](https://arxiv.org/abs/2106.12678) to achieve the memory safety. From my understanding, it's some kind of [Second-Class References](https://borretti.me/article/second-class-references). Using it we don't really need borrow checker, but we sacrifice some flexibility. I decided to try it out in `Mo`, and it's a lot easier to implement.

However, the second-class reference still has some limitations, like the iterator is hard to implement with it. I started thinking that we need to accept tradeoffs in the design of programming languages. We can't have everything. We need to choose what we want to sacrifice for the benefits we want to achieve. I think that's the beauty of programming languages. They are all different, and they all have their own trade-offs. It's like choosing a car. You can choose a sports car that is fast but not very practical, or you can choose a minivan that is practical but not very fast. It's up to you to choose what you want.

I want to choose a car that I'd like to drive, and I want to build a programming language that I'd like to use. It must be a static typed programming language, like `TypeScript`. I don't want dynamic typed language anymore. But can we move one step further? Can we make type the first class citizen in the language? I found [Idris](https://www.idris-lang.org/) language supports first-class types, but it's a quite high-level language like Haskell. Is there any system programming language that support first-class types? Yes! I found [Zig](https://ziglang.org/) language does that! And its `comptime` feature is really cool. It allows compile-time execution of the code. Then I also learnt about [Odin](https://odin-lang.org/) and [Jai](https://jai-lang.org/), which all have similar compile-time execution capabilities. I think it's a really cool feature, and I want to add it to `Mo` as well.

My Angel baby came to the world in May 2024. My wife gave her a new nick name 柚子 (Yuzu), which is a kind of citrus fruit. I think it's a very cute name. I also think it's a very fitting name for my daughter, because she is sweet and refreshing like a yuzu. I decided to rename my programming language from `Mo` to `Yo`, which is also a cute name and easy to pronounce and remember.

So I decide to make `Yo` simple to use, like its name is easy to pronounce and remember. I decide to remove the Linear Type, Borrow Checker, and Second-class reference from `Yo`. I also think effect handler could be replaced with dependency injection or implicit parameters like in [Scala](https://www.scala-lang.org/) in some sense. Here comes another question: how do we make managing memory easier while guaranteeing some sort of safety? If we don't go with manual memory management like `C` and `Zig`, we either need to introduce a tracing GC, like `Lua`, `Go`, and `JavaScript`, or reference counting, like `Swift`. But they all have drawbacks. GC could stop the world and cause undeterminism, and reference counting cannot handle circular references and sometimes turns read into write. The atomic reference counting could have overhead. But if we use non-atomic reference counting, multi-threading could be a problem. It's all about tradeoffs. I started doing research on how other programming languages handle memory management. I found [Nim](https://nim-lang.org/) uses non-atomic reference counting with a cycle detector. I also found [Swift](https://swift.org/) uses atomic reference counting, but it uses weak pointer to break the cycle, just like `C++` and `Rust`. It's a bit of a hack, but it works. There are some other ways like [Generational References](https://verdagon.dev/blog/generational-references) introduced by [Vale](https://vale.dev/) language, and ["single ownership"](https://docs.inko-lang.org/manual/latest/getting-started/memory-management/) by [Inko](https://inko-lang.org/) language.

I basically tried all of them, including implementing the [Tri-color tracing GC](https://en.wikipedia.org/wiki/Tracing_garbage_collection#Tri-color_marking) that `Go` used, and I also tried the [Biased reference counting: minimizing atomic operations in garbage collection](https://dl.acm.org/doi/10.1145/3243176.3243195) which was used in the latest python 3.14 to elminate the [GIL](https://wiki.python.org/moin/GlobalInterpreterLock). However, these approaches all introduce some kind of extra runtime overhead and complexity. I wanted my language to be simple and deterministic.

In the end, I decided to use non-atomic reference counting like `Nim` for `Yo`, and I will just have to live with the limitations of it. I also implemented a cycle collector used in [QuickJS](https://medium.com/@landerlyoung/anatomy-of-quickjs-garbage-collection-algorithm-fc02f6813ba1). I think it's a good trade-off for the simplicity it brings. I also wanted to bring the idea of compile-time reference counting from the [Lobster](https://strlen.com/lobster/) to `Yo` to eliminate as many reference counting operations as possible at compile-time. The author of `Lobster` also [inspired me](https://github.com/aardappel/lobster/issues/374) on how to handle multi-threadings in the case with non-atomic reference counting. I feel the approach is like the `JavaScript`'s [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers) model. And it makes sense.

In 2025, the vibe coding becomes popular. With the help of LLM, the `Yo`'s development becomes faster and faster. A lot of questions that I had before were perfectly solved, like implementing a static machine for async/await, implementing an effect handler with one-shot delimited continuations that fits in `C` and our current `Yo`'s memory model.

The `Yo` language absorbs ideas from all the programming languages that I have learnt before, and it is a combination of all the good ideas that I have seen. It is a language that I want to use, and I hope it can be useful for other people as well. It is still in its early stages, and there are still a lot of features that I want to add to it and change. But I am excited about the future of `Yo`, and I hope it can be a great programming language for everyone to use.

I feel I regain the passion I had when I was developing `Walley` and `Markdown Preview Enhanced`. To build something great, we need to be the user of it and enjoy using it. This is the my story with programming languages. I will end here with a piece of code from my `WalleyLanguage` that I wrote years ago:

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
March 2026
