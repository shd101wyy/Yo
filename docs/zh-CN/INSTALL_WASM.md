<!-- 与各平台工具链指南一并从 README.md 拆分出来：这是编译目标的配置，
     不是语言文档。 -->

# 编译到 WebAssembly

> Yo 会转译为 C，因此以 WebAssembly 为目标需要安装 Emscripten 并让 Yo 使用它。
> 编译器本身的安装参见 [安装](../../README.md#安装)。


Yo 可以使用 [Emscripten](https://emscripten.org/) 编译到 WebAssembly：

```bash
# 安装 Emscripten（https://emscripten.org/docs/getting_started/downloads.html）
$ git clone https://github.com/emscripten-core/emsdk.git
$ cd emsdk
$ ./emsdk install latest
$ ./emsdk activate latest
$ source ./emsdk_env.sh

# 将 Yo 程序编译为 WASM
$ yo compile main.yo --cc emcc --release -o app

# 生成：app.html + app.js + app.wasm
# 使用 Node.js 运行：
$ node app.js

# 或在浏览器中打开 app.html
```

使用 `--cc emcc` 时，Yo 自动针对 `wasm32-unknown-emscripten` 目标并使用 `libc` 分配器。你也可以使用 `--target wasm32-unknown-emscripten`（会自动选择 `emcc`）。Emscripten 生成一个 `.html` 文件（浏览器外壳）、一个 `.js` 文件（运行时胶水代码）和一个 `.wasm` 文件（编译后的二进制文件）。
