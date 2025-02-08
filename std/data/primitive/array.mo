let { Drop, drop } = import("../../classes/common.mo");

instance<T: Linear with Drop<T>, S: usize> Drop<T[S]> {
  drop(value: T[S]) {
    var i = 0;
    while (i < S) {
      drop((value as (T:Free)[S])[i]);
    }
    consume(value);
  };
}