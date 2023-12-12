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
      Just(x + 1)
    ctl give-int(i)
      Just(i)
  12

/*

13
()

*/