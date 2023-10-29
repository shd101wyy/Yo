fun foo() {
  val xs = list(1,10) // create large list
  val ys = map(xs, inc) // increment elements
  map(ys, print)
  map(xs, print)
}

effect myConsole {
  ctl myPrint(): int
}

fun useConsole() {
  println("useConsole")
  val x: int = myPrint()
  println("x: ")
  println(x)
  val y: int = myPrint()
  println("y: ")
  println(y)

  println("result: ")
  println(x + y)
  x + y

}

fun tryConsole() {
  with handler
    ctl myPrint() {
      println("- resume 1")
      resume(1)
      println("- resume 2")
      resume(2)
    }
    return(x) [x]
  useConsole()
}

fun main() {
  foo()
}