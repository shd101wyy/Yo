import { Id } from "../interface/id.mo";

interface AnotherId<X given Id<X>> {
  anotherId: (x: X)-> X;
}

implements Id<i32> {
  id: (x: i32)-> i32 { x }
}

implements AnotherId<i32> {
  anotherId: (x: i32) -> i32 {
    x + 1
  }
}

enum Option<T: Type> {
  Some(value: T),
  None
}

implements<Y> Id<Option<Y>> {
  id: (x: Option<Y>)-> Option<Y> {
    x
  }
}

implements<Z given Id<Z>> AnotherId<Option<Z>> {
  anotherId: (x: Option<Z>) -> Option<Z> {
    match (x) {
      Some => {
        let { value as v } = x;
        Some(id(v))
      },
      None => {
        x
      }
    }
  }
}