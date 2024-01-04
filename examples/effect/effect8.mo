effect Ask<T> {
  ask: ()-> [Ask<T>] Promise<T>;
}

effect Random {}

extern "C" {
  randomInt: () -> [Random] Promise<i32>;
}

let askTwice = ()-> [Ask<i32>] Promise<i32> {
  await ask() + await ask();
}

let askConst = ()-> Promise<i32> {
  try {
    resume(await askTwice());
  } with Ask<i32> {
    ask: () -> [Ask<i32>] Promise<i32> {
      resume(32);
    }
  }
}

let askRandom = ()-> [Random] Promise<i32> {
  try {
    resume(await askTwice());
  } with Ask<i32> {
    ask: () -> [Ask<i32>, Random] Promise<i32> {
      resume(await randomInt());
    }
  }
}