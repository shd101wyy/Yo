effect GiveInt<T> {
  giveInt: (x: T)-> T;
}

let useGiveInt = (x: i32) -> <GiveInt<i32>> i32 {
  giveInt(x) + x
}