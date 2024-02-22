type SomeValue<T> = {
  value: T;
}

let useSomeValue = <X>(v: SomeValue<X>)-> {
  let x = SomeValue<i32> {value: 12};
  let y: SomeValue<i32> = SomeValue<i32> {value: 13};
}