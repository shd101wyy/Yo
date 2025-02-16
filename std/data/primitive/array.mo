let { Drop, drop } = @import("../../classes/common.mo");

implement<T: Linear with Drop<T>, S: usize> Drop for T[S] {
  drop: (self)-> {
    var i = 0;
    while (i < S) {
      drop((self as (T:Free)[S])[i]);
    }
    consume(self);
  };
}