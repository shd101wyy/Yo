export class Id<T: Free> {
  id: (x: T) -> T {
    x
  }
}

export instance Id<i32> {
  id: (x: i32) -> i32 {
    x + 1
  }
}
