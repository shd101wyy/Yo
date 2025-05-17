import { Id } from "./id.mo";

interface AnotherId<T: Type using Id<T>> {
  anotherId: (x: T)-> T {
    // x
    id(x)
  };
}

/*
implements Id<i32> {
  id: (x: i32)-> i32 {
    x
  }
}

implements AnotherId<i32> {
  anotherId: (x: i32)-> i32 {
    id(x)
  }
}
*/