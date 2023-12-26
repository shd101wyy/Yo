enum Option<T> {
  Some(value: T),
  None,
}

function test(x: Option<i32>) {
  match x {
    case None: {
      0
    }
    case Some: {
      x.value
    }
  }
}