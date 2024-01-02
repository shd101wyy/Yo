effect GiveInt<T> {
  giveInt: (x: T)-> <GiveInt<T>> Promise<T>;
}

let main = ()-> Promise<f32> {
  try {
    let x = await giveInt(12);
    3.4
  } with GiveInt<i32> {
    giveInt: (x: i32)-> <GiveInt<i32>> Promise<i32> {
      if (x > 0) {
        resume(3);
      } else {
        abort(3.0);
      }
    }
  }
  resume(12.4);
}