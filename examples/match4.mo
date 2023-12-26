enum Color {
  Red,
  Green,
  Blue
}

function test(x: Color) {
  match x {
    case Color.Red: {
      1
    }
    default: {
      2
    }
  }
}