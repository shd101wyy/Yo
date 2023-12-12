effect give-int
  ctl give-int(i: int): int

fun use-effects(): <give-int> int
  give-int(2) + give-int(4)

fun handle-effect(): <console> int
  with handler
    ctl give-int(i: int)
      println("handle give-int")
      (resume(i):int) + resume(i)
  use-effects()
