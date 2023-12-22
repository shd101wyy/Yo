
effect myConsole {
  ctl myPrint(x: string): ()
  ctl anotherFunction(): ()
}

fun useMyConsole() {
  myPrint("Hello, world!")
}

fun tryUseMyConsole() {
  with handler
    ctl myPrint(x) {
      println(x)
    }
    ctl anotherFunction() {()}
  useMyConsole()
}