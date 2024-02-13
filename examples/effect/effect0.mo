interface GiveInt {
  giveInt: ()-> [GiveInt] i32;
}

let main = ()-> [GiveInt] i32 {
  let x = giveInt();
  x
}