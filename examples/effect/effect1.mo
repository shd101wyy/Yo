interface GiveInt<T> {
  giveInt: (x: T)=> [GiveInt<T>] T;
}

let useGiveInt1 = (x: i32)=> [GiveInt<i32>] i32 {
  giveInt(x) // + x
}

let useGiveInt2 = (x: i32)=> [GiveInt<i32>] i32 {
  GiveInt<i32>.giveInt(x) // + x
}

let useGiveInt3 = (x: i32)=> [GiveInt<i32>] i32 {
  GiveInt.giveInt(x) // + x
}