import { Id } from "../classes/id.mo";

type MyType<T: Type using Id<T>> = {
  value: T
}

implements Id<i32> {
  id: (x: i32)-> i32 {
    x
  }
}

let test = (x: MyType<i32>)-> i32 {
  let { value } = x;
  value
}