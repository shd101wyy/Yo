let { Drop, drop } = @import("../../classes/common.mo");

instance <T: Linear with Drop<T>, S: usize> Drop<T[S]> {
  drop: (self)-> {
    var i = 0;
    while (i < S) {
      drop((self as (T:Free)[S])[i]);
    }
    consume(self);
  };
}