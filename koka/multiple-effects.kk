
effect give-int
  ctl give-int(i: int): int

effect give-bool
  ctl give-bool(b: bool): int

fun use-effects(): <give-int,give-bool> int
  give-int(2) + give-bool(True)

fun handle-multi-effects(): <console> int
  with handler // outer handler will `return` after
    return(i)
      println("return give-int")
      println(i: int)
      i + 3
    ctl give-int(i) 
      println("resume give-int")
      resume(i)
  with handler // inner handler will `return` first
    return(b) 
      println("return give-bool")
      println(b: int)
      b + 4
    ctl give-bool(b) 
      println("resume give-bool")
      if b then resume(1) else resume(0)
  use-effects()
