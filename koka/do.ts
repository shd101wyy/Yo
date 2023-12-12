function test(arg: number, resume: (val: number) => number): number {
  return resume(arg + 1);
}

test(1, (x) => x + 1);
