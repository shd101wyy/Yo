enum Option<T> {
  Some(value: T),
  None,
}

function test(x: Option<i32>) {
  match x {
    case Some: {
      let { value } = x;
      value
    }
    default: {
      0
    }
  }
}