// https://www.microsoft.com/en-us/research/wp-content/uploads/2017/05/asynceffects-msr-tr-2017-21.pdf

enum Result<OkType, ErrorType=symbol> {
  Ok(value: OkType),
  Error(error: ErrorType),
}

effect Exception<ResumeType> {
  control throw: (s: symbol)=> ResumeType;
}

let try_ = <T>(action: ()=> T)=> Result<T, symbol> {
  try {
    action();
  } with Exception<Result<T, symbol>> {
    return: (x)=> {
      Ok(x)
    };
    control throw: (s)=> {
      abort(Error(s));
    };
  }
}

let untry = <T>(result: Result<T, symbol>)=> [Exception<T, symbol>] T {
  match (result) {
    Ok => {
      result.value
    }
    Error => {
      throw(result.error)
    }
  }
}

effect Async<OkType=(), ErrorType=symbol> {
  control await: 
    (initiate: 
      (callback: (result: Result<OkType, ErrorType>)=> ())=> ()
    )=> Result<OkType, ErrorType>
}

let await1 = <T>(initiate: (callback: (result: T)=> ())=> ())=> [Async<T>] T {
  untry(
    await((cb)=> {
      initiate((result)=> {
        cb(Result.Ok(result))
      })
    })
  )
}

let await0 = (initiate: (callback: ()=> ())=> ())=> [Async<()>] () {
  await1((cb)=> {
    initiate(()=> {
      cb(())
    })
  })
}

let wait = (secs: i32)=> [Async<()>] () {
  await0((cb)=> {
    setTimeout(()=> {
      cb()
    }, secs * 1000)
  })
}

let helloWorld = ()=> [Async<()>] () {
  console.log("hello");
  wait(2);
  console.log("world");
}

let main = ()=> {
  try {
    helloWorld();
  } with Async<()> {
    control await: (initiate)=> {
      initiate(resume);
    }
  }
}
