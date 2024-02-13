interface GiveInt<T> {
  giveInt: (x: T)-> [GiveInt<T>] T;
}

let useGiveInt = (x: i32)-> [GiveInt<i32>] i32 {
  giveInt(x) // + x
}