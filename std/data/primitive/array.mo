let { Drop, drop } = @import("../../classes/common.mo");

impl<T: Linear impl Drop<T>, S: usize> Drop for T[S] {
  drop: (self)-> {
    var i = 0;
    while (i < S) {
      drop((self as (T:Free)[S])[i]);
      i = i + 1;
    }
    @consume(self);
  };
}