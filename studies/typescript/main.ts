import { Color, MyType, Red, x, y, z } from "./module";
console.log(x, y, z);
console.log(Color, Red);

function print(x: MyType) {
  console.log(x);
}

console.log(MyType === 12);

interface SomeValue<T> {
  value: T;
}

function useSomeValue(v: SomeValue<number>) {
  console.log(v.value);

  const x: SomeValue<string> = {
    value: "Hi there",
  };
  console.log(x);
}

interface Coroutine<T> {
  step: number;
  context: T;
  parent: Coroutine | null;
}
