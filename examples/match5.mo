enum Option<T> {
  Some(value: T),
  None,
}

let test = (x: Option<i32>)->i32 {
  match x {
    case None: {
      0
    }
    case Some: {
      x.value
    }
  }
}