effect give-data<a>
  ctl give-data(i: a): a

fun handle-effect()
  with handler
    ctl give-data(i: int)
      resume(i + 1)
  with handler
    ctl give-data(i: float64)
      resume(2.4)
  give-data(1)
