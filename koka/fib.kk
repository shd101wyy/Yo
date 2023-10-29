fun fib(n)
  val x = ref(0)
  val y = ref(1)
  repeat(n) 
    val y0 = !y
    y := !x + !y
    x := y0
  !x

fun show(x: ref<h, int>): <console,read<h>|_e> () {
  println(!x)
}

fun test-ref() {
  val x = ref(0)
  x
}

fun use-ref() {
  val x = test-ref()
  println("done")
  ()
}