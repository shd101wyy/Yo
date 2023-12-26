enum Color {
  Red,
  Green,
  Blue
}

function test(x: Color) {
  match x {
    case Red: {
      1
    }
    default: {
      2
    }
  }
}