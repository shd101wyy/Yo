# 我与编程语言的故事

我学的第一门编程语言是 [Java](<https://en.wikipedia.org/wiki/Java_(programming_language)>)。那是 2010 年，我 16 岁，在高中选了计算机导论课。说实话，那门课差点让我永远远离编程。连 `for` 循环都看不懂。光是一个"hello world"就已经让人崩溃了：

```java
public class HelloWorld {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}
```

`static` 是什么意思？为什么需要 `void`？`String[] args` 又是干什么的？为什么不能直接写 `println("Hello, World!");`，非要写 `System.out.println("Hello, World!");`？Java 让我觉得编程就是一场专门折磨初学者的精心骗局。

后来申请大学的时候，为了 AP 考试，我又试着捡起编程。幸运的是，我买了一台 iPad（初代，32 GB——那个厚得能当菜板的），在上面发现了 [MIT OCW（开放课程）](https://ocw.mit.edu/)。现在已经记不清课程名了，但作业是用 `Java` 编程让一个机器人在网格上移动。那一刻突然就开窍了。用代码控制机器人这个想法让我着迷，我终于理解了编程是怎么回事。从此一发不可收拾。面向对象编程让我大开眼界，数据结构和算法真的很有趣，我什么都想学。

2011 年冬天，大学申请结束后，我回老家过寒假，只带了 iPad。这次我试着学 `C`。我用模拟器在 iPad 上装了 Windows 3.1，里面自带一个 Turbo C 编译器。没错——2011 年，在 iPad 上运行 Windows 3.1。登峰造极的工程壮举。`C` 的编译和运行速度比 `Java` 快得多，让我惊叹不已。而且 `C` 可以直接操控内存，这一点也让我着迷。指针！我至今记得写出一个矩阵乘法程序时有多兴奋。编译通过了，运行通过了，结果正确。人生美好。

![Turbo C](https://www.thecrazyprogrammer.com/wp-content/uploads/2013/01/Download-Turbo-C-for-Windows-7-10-11-3264-Bit.png)

之后，我找到一本叫《人工神经网络》的书（如果没记错的话）。那是一本老书。照着书，我试着用 [Python](https://www.python.org/) 实现不同类型的神经网络。和 `C`、`Java` 比起来，`Python` 写起来简直太轻松了。连 `main` 函数都不需要！hello world 一行就搞定了：

```python
print "Hello, World!"
# 是的，我是 Python 2，不是 Python 3 :)
```

2012 年，我照着那本书做了一个相当幼稚的 Python 库，叫 [PyNeuron](https://github.com/shd101wyy/pyneuron)。虽然很简陋，但在这个过程中我学到了很多关于神经网络和 `Python` 的知识。那也是我第一次尝试 Ubuntu 12.04——我的 Linux 初体验。在 Linux 上搭建编程环境比 Windows 简单太多了。命令行简直像超能力一样。差不多同一时期，我也发现了 Git，并开始处处使用它。

拿到大学录取后，我爸给我买了一台 MacBook Pro Retina（2012 款）。我在上面装了 Xcode，然后试着在 iPhone 4 上运行 `Python`。这时候我遇到了 `Objective-C`。它像 `C`，但多了一些步骤……还有一大堆方括号。如今回想起来，我只记得写了一大堆 `retain` 和 `release`。别的什么都不记得了。不过我确实成功地把 `Python` 移植到了 iPhone 上，靠的是链接一些静态库。看到自己的代码在手机上运行，感觉像变魔术一样。

上了大学之后，我学了更多编程语言。`C++` 用于数据结构和算法课。`Python` 用于数据科学和机器学习。更多的 `C` 用于系统编程和嵌入式系统。大一时，我试着自己造一门编程语言，取名 [Walley](https://github.com/shd101wyy/Walley0.0)（0.0 版）。名字来自电影《[瓦力](https://en.wikipedia.org/wiki/WALL-E)》——我希望我的编程语言能够造出一个像瓦力那样的机器人。（雄心勃勃？也许吧。异想天开？绝对是。）我用 `C` 实现了一个词法分析器、语法分析器和解释器。因为当时还没学过编程语言和编译器课程，所以实现得相当粗糙。

![Wall-E](https://github.com/user-attachments/assets/22b4d1c6-e970-4403-ada9-866489832f33)

在研究如何改进 Walley 的过程中，我偶然发现了 [Scheme](https://www.scheme.org/)——`Lisp` 的一种方言。它和我之前用过的任何语言都完全不同。`Scheme` 的简洁和优雅让我着迷。S 表达式太优美了！我能感受到 `Lisp` 的禅意：_代码即数据，数据即代码。_ 很难想象一门编程语言能如此灵活！顺着这条线索，我找到了 [SICP](https://web.mit.edu/6.001/6.037/sicp.pdf)，它让我对递归——尤其是尾调用优化的递归——有了深刻的理解。用 `Scheme` 短短几行就能实现一个微分方程求解器，简直像变魔术。至于 `call/cc`？那基本上就是时间旅行。

```scheme
(define (factorial n acc)
  (if (= n 0)
      acc
      (factorial (- n 1) (* n acc))))
```

受 `Scheme` 启发，我用 `C` 实现了一个 Lisp 方言，取名 [WalleyLanguage](https://github.com/shd101wyy/WalleyLanguage)。多亏了 S 表达式，这次词法分析器和语法分析器简单多了。我还为它做了一个简单的虚拟机，灵感来自 [Lua](https://www.lua.org/)——另一个优美简洁的语言，我在大学 ACM 社团的一次游戏开发 Hackathon 中用过它。我借鉴了 Lua 基于堆的虚拟机设计。WalleyLanguage 使用引用计数，但没有处理循环引用。所以有内存泄漏的问题，只是我一直到后来学了追踪式垃圾回收才意识到。无知是福。

随着越来越深入 `Lisp` 的世界，我开始探索 [Clojure](https://clojure.org/) 和 [Common Lisp](https://common-lisp.net/)。我也开始用 [Emacs](https://www.gnu.org/software/emacs/) 作为编辑器，因为它用 `Emacs Lisp` 作为扩展语言。整个大学期间，我只用 `Emacs`，从没碰过 `Vim`。为什么？因为 Emacs 用的是 Lisp！（这是完全理性的决定，不接受反驳。）而且我很幸运，大学的"编程语言与编译器"课程用 `Scheme` 做作业。我拿了 A+——这对于一个痴迷了两年括号的人来说，毫不意外。

有一天，我试着在浏览器里运行一个 Java Applet，发现困难重重。我知道 [JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript) 的存在但从没试过。我试了一下，发现只要打开浏览器控制台输入 `alert("Hello, World!")` 就能弹出一个窗口。不需要类，不需要 `public static void main`，不需要 `System.out.println`。爽就完了。我开始深入学习 `JavaScript`，部分原因是听人说它是"Scheme 的另一种方言"（虽然这个说法有点慷慨，但我接受）。基于原型的对象系统很有趣但也让人困惑——直到我发现了 [io](https://iolanguage.org/)。

![Java Applet](https://media.geeksforgeeks.org/wp-content/cdn-uploads/20211004162124/HelloWorldApplet.jpg)

`io` 是一门极简的语言，令人愉悦。一切都是消息发送。没有关键字。连 `if` 和 `for` 都只是函数：

```io
if(a == 1, writeln("a is 1"), writeln("a is not 1"))

for(i, 1, 10, write(i, " "))
// -> 1 2 3 4 5 6 7 8 9 10
```

从 `io` 中，我终于理解了基于原型的对象系统是如何工作的——本质上就是一条委托链。我给 `Walley` 加了一个基于原型的对象系统，比基于类的面向对象实现起来简单多了。

接着我想把 `Walley` 带到 Web 上。我用 `JavaScript` 实现了 [Walley0.1](https://github.com/shd101wyy/Walley0.1)、[Walley0.2](https://github.com/shd101wyy/Walley0.2) 和 [Walley0.3](https://github.com/shd101wyy/Walley0.3)。在构建这些版本的过程中，我对 `JavaScript` 的理解不断加深。Node.js 刚刚走红，能用一门语言同时做前端和后端，感觉很酷。

2014 年，`Atom` 编辑器发布了。我当时在学算法课，觉得写 LaTeX 比 Markdown 慢太多，但又需要 LaTeX 的数学公式渲染。`Atom` 上有一个叫 [markdown-preview-plus](https://github.com/atom-community/markdown-preview-plus) 的插件，但（如果我没记错的话）它不支持滚动同步。于是我自己造了一个：[markdown-preview-enhanced](https://github.com/shd101wyy/markdown-preview-enhanced)。Atom 官方的插件开发使用 [CoffeeScript](https://coffeescript.org/)，一门编译到 `JavaScript` 的语言。`CoffeeScript` 有类似 Python 的缩进风格和大量语法糖——箭头函数、类、列表推导、解构赋值。比那个年代的 `JavaScript` 简洁得多，当时的 JavaScript 还没有 `let`、`const`、箭头函数和类。

![Atom](https://media.geeksforgeeks.org/wp-content/uploads/20200526090632/1406-4.png)

随着 `markdown-preview-enhanced` 越来越受欢迎，另一个编辑器出现了：Visual Studio Code。有人请求我做一个 VS Code 版本。我犹豫了——同时维护两套代码库听起来很痛苦。但这也是学习 [TypeScript](https://www.typescriptlang.org/) 的好机会——`TypeScript` 是 `JavaScript` 的超集，带有静态类型。VS Code 推崇 TypeScript，而 Atom 使用 CoffeeScript。我决定用 TypeScript 重写 Atom 版本。这是一个很好的决定。有了类型之后，代码的可维护性大大提高。从此我所有项目都用 `TypeScript`，再也没回头。

2015 年，我选了计算机图形学和虚拟现实课程，使用 [C#](<https://en.wikipedia.org/wiki/C_Sharp_(programming_language)>) 和 `Unity`。`C#` 看起来很像 `Java`，但在细微之处有所不同。那时候我还在狂玩 [Minecraft](https://www.minecraft.net/en-us)，自然而然地花了太多时间试图用 `C#` 和 `Unity` 复刻它。如今，我对 `C#` 的主要印象就是它长得很像 `Java`。仅此而已。

那个暑假，我在[知乎](https://www.zhihu.com/)实习——一个类似 Quora 的中文问答网站。在那里我用了 `JavaScript`、`TypeScript` 和 `Python`——学会了 React、Angular 和 Tornado Web 框架。也是在那里我第一次接触了 [Go](https://golang.org/)。`Go` 简洁得令人耳目一新。Goroutine 和 Channel 让并发编程感觉很自然——和 JavaScript 的回调地狱相比简直天壤之别。标准库在构建 Web 服务器方面非常出色。而且性能在某些场景下可以媲美 `C`。美好的时光。

2016 年，我在编译器课上更多地使用了 `C++`，涉及 [LLVM](https://llvm.org/)。讽刺的是，我现在几乎不记得 `C++` 了，因为再也没碰过它。我还选了一门课，有人展示了用 [Solidity](https://www.soliditylang.org/) 在以太坊上构建投票应用——这是我第一次接触区块链。但当我听说部署智能合约要*花钱*的时候，我默默退缩了。2017 年毕业后情况发生了变化，我不知怎的就进入了 Web3 行业，正式学了 `Solidity`。在那段时间，我也发现了 `Rust`——一门真正重塑了我思维方式的语言。所有权模型是我从未见过的东西。没有垃圾回收器也能保证内存安全！但和借用检查器作斗争很痛苦，生命周期花了我很长时间才内化。不过零成本抽象和安全保证是值得的。

2019 年，我和一个大学同学在深圳创业。我们在做帮助销售人员找到潜在客户、帮助投资人发现投资机会的 AI 产品。我们选择了 [Flutter](https://flutter.dev/) 做跨平台移动和 Web 开发。Flutter 使用 `Dart`，它的感觉像 `TypeScript`，但类型写在变量名前面（`int x` 而不是 `x : int`）。这门语言没有像 Lisp、JavaScript 和 Rust 那样让我感到惊喜。有时候工具就只是工具。

2020 年，我回到之前的公司，发现他们已经把 [PHP](https://www.php.net/) 替换成了后端用 [Haskell](https://www.haskell.org/)，前端用 [PureScript](https://www.purescript.org/)，DevOps 用 [Nix](https://nixos.org/)。我听说 Haskell 很多年了但一直没试过——`Monad` 的概念一直用 `>>=` 把我推开。然而一旦被迫在工作中使用，Monad 突然就说得通了。我也对 [Functor、Applicative 和 Monad](https://www.adit.io/posts/2013-04-17-functors,_applicatives,_and_monads_in_pictures.html) 有了更深的理解。`PureScript` 和 `Haskell` 非常相似，但编译到 `JavaScript`。那段时间我的函数式编程能力突飞猛进。在 DevOps 方面，`Nix` 更多的是一种声明式配置语言。从那以后，我在所有项目中都用它，甚至用 [home-manager](https://github.com/nix-community/home-manager) 管理我的操作系统和 home 配置。

![Functor, Applicative, Monad](https://www.adit.io/imgs/functors/recap.png)

2023 年，我妻子怀孕了。我决定做点什么来纪念我的孩子。那么……为什么不造一门编程语言呢？（合情合理。）

在之前的几年里，我反复阅读 [Rust 之书](https://doc.rust-lang.org/book/)，试图彻底搞懂所有权和借用检查器。有一天，我发现了 [Austral](https://austral-lang.org)，一门使用线性类型来保证内存安全的语言。它基于区域的[借用检查器](https://austral-lang.org/tutorial/borrowing)比 Rust 的容易理解多了。我决定构建一门类似的带有线性类型的语言。我把它叫做 [Mo](https://github.com/shd101wyy/Yo/commit/56eeb6841fadd08afa8c332b6377d34f87168914)，因为好发音好记——而且我想给孩子取小名叫"默默"。我选择了 `TypeScript`（我日常使用最多的语言）做原型开发，并决定转译到 `C`。

然而在开发过程中，`Mo` 变得越来越像 `Rust`。这不是我的本意。我希望它的语法像 `Lisp` 一样容易解析，拥有简单的 AST，从而使宏系统的实现变得简单。但我又不想直接用 S 表达式——在 S 表达式上集成类型系统总感觉很别扭。现有的方案如 [Typed Racket](https://docs.racket-lang.org/ts-guide/quick.html) 和 Clojure 的 [core.typed](https://github.com/clojure/core.typed) 看起来都不够自然。而且说实话——不好好排版的 S 表达式就是括号炼狱：

![](https://andreyor.st/2020-12-03-we-need-to-talk-about-parentheses/how-to-save-the-princess-in-lisp.jpg)

我在网上发现了 [Elixir](https://elixir-lang.org)，从它的宏系统中嗅到了 `Lisp` 的气息。它的语法简洁清晰。我决定把 `Elixir` 的风格与 `io` 的"一切皆函数"理念结合起来。在 `Elixir` 中，函数调用可以加括号也可以不加——`add(1, 2)` 和 `add 1, 2` 都是合法的。这使得 `io` 风格的控制流在不加括号时看起来更自然：

```io
if a == 1,
  writeln("a is 1"),
  writeln("a is not 1")

// 逗号仍然是必要的，只是括号变成了可选的。
```

不错。但还有一个问题：运算符优先级。`1 + 3 * 4` 和函数调用语法模型不太兼容。解析器仍然需要为优先级添加特殊逻辑。而 Lisp 中的 `(+ 1 (* 3 4))` 则直截了当。我在这个问题上卡了一阵子，直到 `Austral` 的[反特性](https://austral-lang.org/features)列表启发了我：

> - 没有算术优先级。
>
> 和算术一样，Austral 中逻辑运算符也没有运算符优先级：超过一层的表达式必须完全加上括号：
>
> ```austral
> -- 不合法:
> a and b and c and d
> -- 合法:
> a and (b and (c and d))
> ```

我们不需要运算符优先级！只需要强制使用显式括号。所以 `Mo` 中的 `1 + 2 + 3` 必须写成 `(1 + 2) + 3` 或 `1 + (2 + 3)`。虽然啰嗦了一点，但解析起来大大简化，也更一致。是个好的权衡。

语法确定之后，我对 `Mo` 感觉很满意。然后我读了 [Algebraic Effects for the Rest of Us](https://overreacted.io/algebraic-effects-for-the-rest-of-us/)，思维再次被颠覆。代数效应提供了一种比 Monad 更具组合性的副作用管理方式。我发现了 [Koka](https://koka-lang.github.io/koka/doc/index.html)、[Eff](https://www.eff-lang.org/)、[Effekt](https://effekt-lang.org/)、[Ante](https://antelang.org/) 和 [Unison](https://www.unison-lang.org/)——都很美。我想给 `Mo` 加上代数效应，但要在一门转译到 C、使用线性类型进行手动内存管理的语言中实现效应处理器，难度极大。于是我暂停了。

我还发现，为 `Mo` 实现借用检查器比预期更难。Austral 的方案在某些场景下有局限性。我查看了 [Hylo](https://hylo-lang.org/)，它使用[可变值语义](https://arxiv.org/abs/2106.12678)来保证内存安全——本质上就是[二等引用](https://borretti.me/article/second-class-references)。不需要借用检查器，代价是损失一些灵活性。我在 `Mo` 中试了一下，实现起来确实简单多了。

但二等引用也有自己的局限——比如迭代器就很痛苦。我开始接受一个事实：语言设计从根本上说就是在做取舍。鱼和熊掌不可兼得。就像选车：你可以选跑车——快但不实用，或者选面包车——能装菜但跑不快。（或者你可以花好几年在车库里自己造一辆车。猜猜我选了哪个。）

我想要一门静态类型语言，像 `TypeScript` 那样。不要动态类型。但能不能更进一步——让类型成为一等公民？我发现了 [Idris](https://www.idris-lang.org/)，它支持一等类型，但和 Haskell 一样比较高层。有没有支持一等类型的系统级语言？有——[Zig](https://ziglang.org/)！它的 `comptime` 特性非常酷，支持编译期代码执行。我还了解了 [Odin](https://odin-lang.org/) 和 [Jai](https://jai-lang.org/)，它们有类似的能力。

2024 年 5 月，我的小天使来到了这个世界。我妻子给她取了小名叫柚子——一种柑橘类水果。甜美、清新，完美。我把我的编程语言从 `Mo` 改名为 `Yo`（柚），与之呼应。

我决定让 `Yo` 简洁——用起来和它的名字一样简单。我去掉了线性类型、借用检查器和二等引用。我也意识到代数效应处理器可以换一种方式来实现——通过依赖注入和隐式参数，就像 [Scala](https://www.scala-lang.org/) 那样。

这引出了一个重大问题：没有这些复杂机制，如何安全地管理内存？如果不是手动管理（像 `C` 和 `Zig`），就需要追踪式 GC（`Lua`、`Go`、`JavaScript`）或引用计数（`Swift`）。两者都有缺点。GC 可能会暂停整个世界；引用计数原生无法处理循环引用，且原子引用计数有额外开销。非原子引用计数更便宜，但多线程就成了问题。到处都是取舍。

我研究了其他语言的做法。[Nim](https://nim-lang.org/) 使用非原子引用计数配合循环检测器。[Swift](https://swift.org/) 使用原子引用计数配合弱引用来打破循环（类似 `C++` 和 `Rust`）。还有 [Vale](https://vale.dev/) 的[代际引用](https://verdagon.dev/blog/generational-references)，以及 [Inko](https://inko-lang.org/) 的["单一所有权"](https://docs.inko-lang.org/manual/latest/getting-started/memory-management/)。

我基本上全都试了一遍——包括 `Go` 使用的[三色标记追踪式 GC](https://en.wikipedia.org/wiki/Tracing_garbage_collection#Tri-color_marking)，以及 Python 3.14 中用来消除 [GIL](https://wiki.python.org/moin/GlobalInterpreterLock) 的[偏向引用计数](https://dl.acm.org/doi/10.1145/3243176.3243195)。但它们都引入了额外的运行时开销和复杂性。我想要简单和确定性。

最终，我选择了非原子引用计数加上基于 [QuickJS](https://medium.com/@landerlyoung/anatomy-of-quickjs-garbage-collection-algorithm-fc02f6813ba1) 方案的循环收集器——和 `Nim` 相同的策略。我还引入了 [Lobster](https://strlen.com/lobster/) 的编译期引用计数优化，以在编译期消除尽可能多的引用计数操作。Lobster 的作者还在非原子引用计数的多线程处理方面[给了我启发](https://github.com/aardappel/lobster/issues/374)。这种方式类似于 JavaScript 的 [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers) 模型——而且是合理的。

2025 年，氛围编程（vibe coding）成为了一种潮流。在 LLM 的辅助下，`Yo` 的开发速度大大加快。那些之前困扰我的难题——比如实现 async/await 的状态机，或者在 `C` 中实现与 Yo 内存模型兼容的用于效应处理器的一次性限定续延——突然都有了解决方案。

`Yo` 吸收了我一路走来遇到的每一门编程语言的思想。它是我 15 年来在不同语言之间游走所收集到的优秀理念的结晶。它仍处于早期阶段，还有很多功能需要添加和完善。但我对它的发展方向感到兴奋，也希望它能对其他人有所帮助。

我觉得我重新找回了当年做 `Walley` 和 `Markdown Preview Enhanced` 时的那种热情。要做出好东西，你自己得是它的用户，而且得享受使用它的过程。这就是我与编程语言的故事。最后用一段我多年前在 `WalleyLanguage` 中写的代码作结：

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

Yiyi 著，
Yo 项目地址: https://github.com/shd101wyy/Yo
2026 年 3 月
