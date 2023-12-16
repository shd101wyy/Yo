import { inst, handler, combineHandlers, execute } from "https://cdn.jsdelivr.net/npm/eff.js@2.0.0/index.min.js";

const GiveInt = inst("GiveInt");

const useGiveInt = async function* () {
  console.log("Start");
  const r = 1 + (yield GiveInt(2)) + 3;
  console.log("End");
  return r;
};

const handleGiveInt = handler(
  GiveInt,
  async function* (v) {
    return v;
  },
  async function* (k, x) {
    // return yield* k(x);
    // return 10 + (yield* k(x)) + 20;
    return x;
  }
);

(async () => {
  console.log(await execute(handleGiveInt(useGiveInt)));
})();
