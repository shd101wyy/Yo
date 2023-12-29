enum Color {
  Red,
  Green,
  Blue
}

let test = (x: Color)-> i32 {
  match x {
    Color.Red => {
      1
    }
    _         => {
      2
    }
  }
}