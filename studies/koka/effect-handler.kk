effect give-int
  ctl give-int(i: int): int

fun handle-effect(): <console> int
  with handler
    return(x)
      x + 10
    ctl give-int(i)
      // resume(i)
      i
  println(give-int(123): int)
  println(give-int(1): int)
  0