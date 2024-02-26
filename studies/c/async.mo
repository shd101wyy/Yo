// Translated from async.c

interface GetIntContext {}
interface TestContext {
  a: i32;
  b: i32;
}

interface Coroutine<CoroutineType, ResumeType, AbortType> {
  resume: (coro: CoroutineType, value: ResumeType)-> ();
  abort: (coro: CoroutineType, value: AbortType)-> ();
}


type Coroutine<SelfContext: Type, ParentContext: Type> = {
  step: i32;
  context: SelfContext;
  parent: Option<Box<Coroutine<ParentContext>>>;
  function: (self: Coroutine<SelfContext>)-> ();
  value: i32;
}

let resumeCoroutine = (optionalCoro: Option<Coroutine>, value: i32)-> {
  match (optionalCoro) {
    Some => {
      let coro = optionalCoro.value;
      coro.step = coro.step + 1;
      coro.value = value;
      coro.function(coro);
    },
    None => {
      // do nothing
    }
  }
}

let abortCoroutine = (coro: Option<Coroutine>, value: i32)-> {
  match (coro) {
    Some => {
      let coro = optionalCoro.value;
      coro.step = -1;
      coro.value = value;
      coro.function(coro);
      abortCoroutine(coro->parent, value);
    },
    None => {
      // do nothing
    }
  }
}

let x = 1;

let getInt = (self: Coroutine<GetIntContext>)-> {
  if (x == 1) {
    abortCoroutine(self.parent, x);
  } else {
    x = x + 1;
    resumeCoroutine(self.parent, x);
  }
}

let test = (self: Coroutine<TestContext>)-> {
  if (self.step == 0) {
    let getIntCoroutine: Coroutine<GetIntContext> = Coroutine<GetIntContext> {
      step: 0,
      context: GetIntContext {},
      parent: Some(self),
      function: getInt,
      value: 0
    };
    getInt(getIntCoroutine);
  } else if (self.step == 1) {
    self.context.a = self.value;
    let getIntCoroutine: Coroutine<GetIntContext> = Coroutine<GetIntContext> {
      step: 0,
      context: GetIntContext {},
      parent: Some(self),
      function: getInt,
      value: 0
    };
    getInt(getIntCoroutine);
  } else if (self.step == 2) {
    self.context.b = self.value;
    resumeCoroutine(self.parent, self.context.a + self.context.b);
  }
}