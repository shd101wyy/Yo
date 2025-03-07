let { Drop, drop } = @import("../../classes/common.mo");

impl<T: Linear impl Drop, S: usize> Drop<T[S]> {
  drop: (self)-> {
    var i = 0;
    while (i < S) {
      (self as (T:Free)[S])[i].drop();
      i = i + 1;
    }
    @consume(self);
  };
}