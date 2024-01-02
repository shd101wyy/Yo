let test = (resume1: (value: i32)-> (), 
            abort1: <T>(value: T)-> ())-> {
  resume1(12);
  abort1(13);
}