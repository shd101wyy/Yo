effect GiveInt<T> {
  giveInt: control (x: T)-> <GiveInt<T>>T;
}

let main = ()-> i32 {
  try {
    let x = giveInt(12);
    x
  } with GiveInt<i32> {
    giveInt: control (x: i32)-> <GiveInt<i32>>i32 {
      if (x > 0) {
        resume x;
      } else {
        abort x;
      }
    }
  }
}