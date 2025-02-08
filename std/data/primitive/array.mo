import { Drop, drop } from "../../classes/common.mo";

instance<T: Type with Drop<T>, S: usize> Drop<T[S]> {
  drop(value: T[S]) {
    for (let i = 0; i < S; i++) {
      drop(value[i]);
    }
  };
}