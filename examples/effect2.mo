effect GiveInt {
  giveInt: (x: i32)=> i32;
}

function test() {
  try {
    giveInt(12)
  } with GiveInt {
    giveInt: (x: i32) => x + 1
  }
}