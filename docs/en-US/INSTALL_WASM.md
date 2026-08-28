<!-- Split out of README.md with the per-platform toolchain guides: this is
setup for a compile TARGET, not language documentation. -->

# Compiling to WebAssembly

> Yo compiles to C, so targeting WebAssembly means installing Emscripten and
> pointing Yo at it. See [Installation](../../README.md#installation) for the
> compiler itself.


Yo can compile to WebAssembly using [Emscripten](https://emscripten.org/):

```bash
# Install Emscripten (https://emscripten.org/docs/getting_started/downloads.html)
$ git clone https://github.com/emscripten-core/emsdk.git
$ cd emsdk
$ ./emsdk install latest
$ ./emsdk activate latest
$ source ./emsdk_env.sh

# Compile a Yo program to WASM
$ yo compile main.yo --cc emcc --release -o app

# This produces: app.html + app.js + app.wasm
# Run with Node.js:
$ node app.js

# Or open app.html in a browser
```

When using `--cc emcc`, Yo automatically targets `wasm32-unknown-emscripten` and uses the `libc` allocator. You can also use `--target wasm32-unknown-emscripten` (which auto-selects `emcc`). Emscripten produces an `.html` file (browser shell), a `.js` file (runtime glue), and a `.wasm` file (compiled binary).
