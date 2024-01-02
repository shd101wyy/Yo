effect GiveInt {
  giveInt: ()-> <GiveInt>i32;
}

let add = (x: i32, y: i32)-> i32 {
  x + y
}

let main = ()-> <GiveInt> i32 {
  add(3, 4);
  giveInt()
}