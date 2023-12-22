effect give-int
  ctl give-int(i: int): int

fun handle-effect(): int
  with handler
    ctl give-int(i)
      if i >= 10 then
        i
      else
        resume(i)
  give-int(5) + give-int(12) + give-int(4)

// 12