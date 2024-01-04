effect GiveInt {
  giveInt: (x: i32)-> [GiveInt] i32;
}

let useGiveInt = ()-> [GiveInt] i32 {
  let x = giveInt(12);
  x
}

let test = ()-> [GiveInt] i32 {
  let x = useGiveInt();
  x
}