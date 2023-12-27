export class Id<T: Free> {
  id: (x: T) -> T {
    x
  }
}

function main() {
  let x = id(12);
  x
}