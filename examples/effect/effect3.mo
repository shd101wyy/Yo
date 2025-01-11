interface GiveInt {
  giveInt: (x: i32)=> [GiveInt] i32;
}

let main = (x: i32) => i32 {
  try {
    let n = giveInt(12);
    n + x
  } with GiveInt {
    giveInt: (x: i32)=> [GiveInt] i32 {
      x + 1
    }
  }
}