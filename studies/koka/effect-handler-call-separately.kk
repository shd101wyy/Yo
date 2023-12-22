effect give-int
  ctl give-int(i: int): int

fun handle-effect(): <console> int
  with handler
    return(x)
      x + 10
    ctl give-int(i)
      resume(i)
  val x = give-int(1)
  println(x)
  val y = give-int(2)
  println(2)
  y
