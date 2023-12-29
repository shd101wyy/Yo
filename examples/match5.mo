enum Option<T> {
  Some(value: T),
  None,
}

let test = (x: Option<i32>)->i32 {
  match x {
    None => 0,
    Some => x.value
  }
}