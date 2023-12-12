effect give-int
  ctl give-int(i: int): int

fun show(x: maybe<int>)
  match x
    Just(v) -> println(v: int)
    Nothing -> println("Nothing")

fun handle-effect(): <console> maybe<int>
  with handler
    return(x)
      println("- return")
      Just(x)
    ctl give-int(i)
      Just(i)
  give-int(12) + give-int(14)

/*

12
()

*/