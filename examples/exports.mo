export let x = 1;

export let mut y = 2;

export function add(x: i32, y: i32): i32 {
  x + y
}

export type Data: Linear;

export extern malloc(size: i32): Data;

export class Id<T> {
  id(x: T): T {
    x
  }
}

export instance Id<i32> {
  id(x: i32): i32 {
    x + 1
  }
}

export enum MySome<T> {
  Some(value: T),
  None
}