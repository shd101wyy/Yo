{ Drop, drop } := import "../../interfaces/common.mo";

forall ((T : Linear) <: Drop, comptime(S): usize),
  impl Drop(Array(T, S)), {
    drop: (fn(self) -> {
      mut(i) := 0;
      while i < S, {
        as_free(self)(i).drop();
        i = (i + 1);
      }
      consume(self);
    })
  };