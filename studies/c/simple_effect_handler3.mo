type Coroutine<
  ArgumentsType, 
  ContextType, 
  ResumeType, 
  AbortType, 
  ParentCoroutineType> = {
  arguments: ArgumentsType,
  context: ContextType,
  function: (self: Coroutine<ArgumentsType, ContextType, ResumeType, AbortType>)=> (),
  step: i32,
  value: ResumeType | AbortType,
  parent: ParentCoroutineType
}

interface CoroutineInterface<CoroutineType, ResumeType, AbortType> {
  resume: (coro: CoroutineType, value: ResumeType) => (),
  abort: (coro: CoroutineType, value: AbortType) => (),
}

type GetIntArguments = {
  x: i32
};
type GetIntContext = {};

let getInt = 
  < AbortType, 
    ParentCoroutineType 
    using CoroutineInterface<ParentCoroutineType, i32, AbortType>
  >(
    self: Coroutine<
      GetIntArguments, 
      GetIntContext, 
      i32, 
      AbortType, 
      ParentCoroutineType>)=> {
  let { arguments, context, function, step, value, parent } = self;
  match (step) {
    _ => {
      if (arguments.x > 10) {
        println("resume\n");
        resume(parent, 10);
      } else {
        println("abort\n");
        abort(parent, 0);
      }
    }
  }
}

type MyMainArguments = {}
type MyMainContext = {}

let myMain = (self: Coroutine<MyMainArguments, MyMainContext, (), i32, ParentCoroutineType>)=> {
  let { arguments, context, function, step, value, parent } = self;
  match (step) {
    0 => {
      let getIntArguments: GetIntArguments = GetIntArguments { x: 12 };
      let getIntContext: GetIntContext = GetIntContext {};
      let getIntCoroutine: Coroutine<GetIntArguments, GetIntContext, i32, i32, Coroutine<MyMainArguments, MyMainContext, (), i32, ParentCoroutineType>> = Coroutine<GetIntArguments, GetIntContext, i32, i32, Coroutine<MyMainArguments, MyMainContext, (), i32, ParentCoroutineType>> {
        arguments: getIntArguments,
        context: getIntContext,
        function: getInt,
        step: 0,
        value: 0,
        parent: self
      };
      getInt(getIntCoroutine);
    }
    1 => {
      let value = value as i32;
      println("Done");
    }
    -1 => {
      let value = value as i32;
      println("Aborted");
    }
  }
}

let main = ()=> {
  let myMainArguments: MyMainArguments = MyMainArguments {};
  let myMainContext: MyMainContext = MyMainContext {};
  let myMainCoroutine: Coroutine<MyMainArguments, MyMainContext, (), i32, ()> = Coroutine<MyMainArguments, MyMainContext, (), i32, ()> {
    arguments: myMainArguments,
    context: myMainContext,
    function: myMain,
    step: 0,
    value: 0,
    parent: None
  };
  myMain(myMainCoroutine);
}