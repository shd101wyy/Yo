effect give-int
  ctl give-int(i: int): int

fun handle-effect(): <console> int
  with handler
    return(x)
      x + 10
    ctl give-int(i)
      resume(i) + resume(i)
  give-int(1)

// 22