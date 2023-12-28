effect GiveInt<T> {
  giveInt: control (x: T)-> <GiveInt<T>>T;
}

let main = ()-> f32 {
  try {
    let x = giveInt(12);
    12.4
  } with GiveInt<i32> {
    giveInt: control (x: i32)-> <GiveInt<i32>>i32 {
      if (x > 0) {
        resume 3;
      } else {
        abort 3.0;
      }
    }
  }
}