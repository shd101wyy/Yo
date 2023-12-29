enum Option<T> {
  Some(value: T),
  None,
}

let test = (x: Option<i32>) -> i32 {
  match x {
    Some => x.value,
    _    => 0
  }
}