let asyncFunc = ()-> Promise<i32> {
  abort(true);
  resume(12);
}