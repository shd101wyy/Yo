interface GiveInt {
  control giveInt: (x: i32)=> [GiveInt] i32;
}

let useGiveInt = (x: i32)=> [GiveInt] i32 {
  giveInt(x)
}

let main = ()=> i32 {
  try {
    let x = useGiveInt(1);
    x
  } with GiveInt {
    control giveInt: (x: i32)=> i32 {
      resume(x + 1)
    }
  }
}

