type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  length: (data: &Data)-> i32;
}

type Holder = {
  data: &Data;
}

let test = (holder: Holder)-> {
  // let { data } = holder; // Should give error
                    // as we cannot derefence a reference to Linear value
  let len = length(holder.data);
}

let main = ()-> {
  let data = malloc();
  test(Holder {data: &data});
  consume(data);
}
