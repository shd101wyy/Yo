fun test() {
  val x = ref(0);
  (fn() {
    x := !x + 1;
    val result = !x
    return result
  })
}

fun test2() {
  val x = ref(0)
  x := !x + 1
  !x
}

fun callTest() {
  val closure = test()
  closure()
  closure()
}