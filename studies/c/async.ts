interface GetIntContext {}
interface TestContext {
  a: number;
  b: number;
}

interface Coroutine<SelfContext> {
  step: number;
  context: SelfContext;
  parent: Coroutine<any> | null;
  function: (self: Coroutine<SelfContext>) => void;
  value: number;
}

/*
let x: unknown;
x = 12;
console.log(x);
*/
let x = 0;

function resumeCoroutine<SelfContext>(
  optionalCoro: Coroutine<SelfContext> | null,
  value: number
) {
  if (optionalCoro !== null) {
    const coro = optionalCoro;
    coro.step++;
    coro.value = value;
    console.log("resume: ", value);
    coro.function(coro);
  }
}

function abortCoroutine<SelfContext>(
  optionalCoro: Coroutine<SelfContext> | null,
  value: number
) {
  if (optionalCoro !== null) {
    const coro = optionalCoro;
    coro.step = -1;
    coro.value = value;
    console.log("abort: ", value);
    coro.function(coro);
    abortCoroutine(coro.parent, value);
  }
}

function getInt(self: Coroutine<GetIntContext>) {
  if (x === 1) {
    abortCoroutine(self.parent, x);
  } else {
    x = x + 1;
    resumeCoroutine(self.parent, x);
  }
}

function test(self: Coroutine<TestContext>) {
  if (self.step === 0) {
    const getIntCoroutine: Coroutine<GetIntContext> = {
      step: 0,
      context: {},
      parent: self,
      function: getInt,
      value: 0,
    };
    getInt(getIntCoroutine);
  } else if (self.step === 1) {
    self.context.a = self.value;
    const getIntCoroutine: Coroutine<GetIntContext> = {
      step: 0,
      context: {},
      parent: self,
      function: getInt,
      value: 0,
    };
    getInt(getIntCoroutine);
  } else if (self.step === 2) {
    self.context.b = self.value;
    console.log("here: ", self.context.a + self.context.b);
    resumeCoroutine(self.parent, self.context.a + self.context.b);
  }
}

function main() {
  const testCoroutine: Coroutine<TestContext> = {
    step: 0,
    context: { a: 0, b: 0 },
    parent: null,
    function: test,
    value: 0,
  };
  test(testCoroutine);
}
main();
