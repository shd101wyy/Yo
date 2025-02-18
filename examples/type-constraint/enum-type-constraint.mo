import { Id } from "../classes/id.mo";

enum Option<T: Type using Id<T>> {
  Some(value: T),
  None
}

implements Id<i32> {
  id: (x: i32)-> i32 {
    x
  }
}

let test = (x: Option<i32>)-> i32 {
  match (x) {
    Some -> {
      let {value} = x;
      value
    },
    None -> {
      0
    }
  }
}