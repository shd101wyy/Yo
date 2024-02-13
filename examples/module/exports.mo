export let x = 1;

export let mut y = 2;

export let add = (x: i32, y: i32) -> i32 {
  x + y
}

export type Data: Linear;

export extern "C" {
  malloc: (size: i32)-> Data;
}

export interface Id<T> {
  id: (x: T)-> T {
    x
  }
}

implement Id<i32> {
  id: (x: i32)-> i32 {
    x + 1
  }
}

export enum MySome<T> {
  Some(value: T),
  None
}