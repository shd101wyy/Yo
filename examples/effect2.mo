effect GiveInt {
  giveInt(x: i32): i32;
}

function test() {
  let intHandler = handler GiveInt {
    giveInt(x: i32) {
      x + 1
    }
  }
  intHandler(()=> {
    giveInt(12)
  })
}