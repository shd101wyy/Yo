type Data: Linear;
extern "C" {
  malloc: () => Data;
  free: (data: Data) => ();
}

let test = () => () {
  let data = malloc();
  defer {
    free(data);
  }
  ()
}