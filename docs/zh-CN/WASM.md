# 从 Yo 到 WebAssembly：集成指南

本指南讲的是如何把一个 Yo 库交付给 JavaScript：导出的 API 长什么样、哪块内存归谁所有、
npm 包如何组织，以及 JavaScript 与 TypeScript 包装层如何与模块交互。

- 安装 Emscripten 并编译第一个程序：[INSTALL_WASM.md](./INSTALL_WASM.md)。
- 构建文件参考（`build.executable`、`target`、`add_c_flags`、`.html`/`.js` 输出规则、
  `Platform.Emscripten` / `Platform.Wasi`）：[BUILD_SYSTEM.md](./BUILD_SYSTEM.md) 的
  *交叉编译* 与 *WASM Emscripten 环境* 两节。

下面的示例已用 yo 0.2.49、Emscripten 4.0.12、Node.js 24 和 wasmtime 38 验证。

## 选择目标

| 目标 | 命令 | 输出 | 运行环境 |
| --- | --- | --- | --- |
| `wasm32-unknown-emscripten` | `yo compile src/main.yo --cc emcc --optimize 2 -o app` | `app.html` + `app.js` + `app.wasm` | 浏览器，或 `node app.js` |
| `wasm32-unknown-emscripten`，库 | 同上，改用 `-o api.js` 并加 `--cflags '-sMODULARIZE=1 ...'`（见下文） | `api.js` + `api.wasm` | 由 JavaScript 导入 |
| `wasm32-wasip1` | `yo compile src/main.yo --target wasm32-wasip1 --optimize 2 -o app.wasm` | `app.wasm` | `wasmtime app.wasm` |

`--cc emcc` 会选择 `wasm32-unknown-emscripten`，而 `--target wasm32-unknown-emscripten`
会选择 `emcc`。供 JavaScript 调用的库用 Emscripten；带 `main` 的独立程序用 WASI。

## API 边界

### 导出函数

WebAssembly 模块通过普通的 C 函数与 JavaScript 交互。Yo 的 `str`、`String`、`ArrayList`
以及其他所有托管类型都留在模块内部：边界上只传整数、浮点数和裸指针。

- **JavaScript 调用的每个函数都要 `export(...)`。** 导出的函数在生成的 C 代码中保留原名，
  因此 `-sEXPORTED_FUNCTIONS=_transform` 能找到它。忘记导出的函数会得到一个改编过的名字，
  链接时报错 `wasm-ld: error: symbol exported via --export not found: transform`。
- **库不需要 `main`。** 只导出 API 函数即可。
- **裸指针类型需要在文件顶部声明 `pragma(Pragma.AllowUnsafe);`**，并且每一次解引用或指针
  偏移都要放在 `unsafe(...)` 里（见 [MEMORY_SAFETY.md](./MEMORY_SAFETY.md)）。

在 `wasm32` 上，参数类型对应到 C、再对应到 JavaScript 数值的方式如下：

| Yo | C | JavaScript |
| --- | --- | --- |
| `i32`、`u32` | `int32_t`、`uint32_t` | `number` |
| `usize` | `size_t`（wasm32 上为 4 字节） | `number` |
| `*u8`、`*usize` | `uint8_t*`、`size_t*` | `number`，即 `HEAPU8` 中的字节偏移 |
| `?*u8` | `uint8_t*`，`.None` 即 `NULL` | `number`，`.None` 为 `0` |

### 内存所有权

以下规则保证 JavaScript 调用方既不泄漏也不重复释放：

1. **分配器归模块所有。** JavaScript 只通过导出的 `wasm_alloc` 分配、通过 `wasm_free`
   释放，不经过其他途径。
2. **输入缓冲区归调用方所有。** JavaScript 分配、拷入字节、调用，然后释放该缓冲区。Yo 函数
   不得在调用结束后继续持有指向输入缓冲区的指针。
3. **返回的缓冲区同样归调用方所有。** 返回新内存块的函数要在文档注释中写明这一点，
   JavaScript 把结果拷出后用 `wasm_free` 释放它。
4. **长度通过输出参数返回。** 调用方传入一个指向 `usize` 槽位的指针，调用结束后从中读取长度。

下面是一个遵循这些规则的完整库：

```yo
// src/wasm_api.yo
//! `transform`：输入字节，输出新分配的字节。
pragma(Pragma.AllowUnsafe);

{ GlobalAllocator } :: import("std/allocator");

wasm_alloc :: (fn(size : usize) -> ?*u8)(
  match(
    GlobalAllocator.malloc(size),
    .Some(p) => .Some((*u8)(p)),
    .None => .None
  )
);

wasm_free :: (fn(ptr : ?*u8) -> unit)(
  match(
    ptr,
    .Some(p) => GlobalAllocator.free(.Some((*void)(p))),
    .None => ()
  )
);

// 选项位；JavaScript 包装层构造同样的掩码。
FLAG_UPPER :: i32(1);
FLAG_UNDERSCORE :: i32(2);

/// 变换 `input_ptr` 处的 `input_len` 个字节。结果是一块新内存，由调用方用
/// `wasm_free` 释放；其长度写入 `out_len`。
/// 分配失败时返回 NULL。
transform :: (
  fn(input_ptr : *u8, input_len : usize, flags : i32, out_len : *usize) -> ?*u8
)({
  upper := ((flags & FLAG_UPPER) != i32(0));
  underscore := ((flags & FLAG_UNDERSCORE) != i32(0));
  // `malloc(0)` 可能返回 NULL，所以至少申请一个字节。
  size := cond(
    (input_len == usize(0)) => usize(1),
    true => input_len
  );
  match(
    wasm_alloc(size),
    .Some(out) => {
      (i : usize) = usize(0);
      while(i < input_len, {
        (b : u8) = unsafe(input_ptr.add(i).*);
        // 只改动 ASCII 字节，因此 UTF-8 输入仍是合法的 UTF-8。
        cond(
          (upper && ((b >= u8(97)) && (b <= u8(122)))) => {
            b = (b - u8(32));
          },
          (underscore && (b == u8(32))) => {
            b = u8(95);
          },
          true => ()
        );
        unsafe(out.add(i).* = b);
        i = (i + usize(1));
      });
      unsafe(out_len.* = input_len);
      .Some(out)
    },
    .None => .None
  )
});

export(wasm_alloc, wasm_free, transform);
```

`GlobalAllocator.malloc` 和 `.free` 使用 `?*void`：`malloc` 失败时返回 `.None`，
`free(.None)` 什么也不做。`wasm_free` 接受 `?*u8`，因此 JavaScript 可以安全地传入 `0`。

### 把输入借用为 `str`

`str.from_raw_parts(ptr, len)` 不拷贝地把调用方的字节包装成 `str`，函数便可以对其使用
`str` 的 API。这个视图的有效期取决于背后的缓冲区：只在调用期间使用；若有内容需要活过本次调用，
就拷贝一份（`String.from(view)`）。

```yo
//! 在一次调用期间把调用方的字节借用为 `str`。
pragma(Pragma.AllowUnsafe);

/// 统计 `input_ptr` 处 `input_len` 个字节中等于 `needle` 的字节数。
count_byte :: (fn(input_ptr : *u8, input_len : usize, needle : u8) -> usize)({
  // 是视图而非拷贝：只在调用方释放 `input_ptr` 之前有效。
  view := str.from_raw_parts(input_ptr, input_len);
  (n : usize) = usize(0);
  (i : usize) = usize(0);
  while(i < view.len(), {
    cond(
      (view.bytes(i) == needle) => {
        n = (n + usize(1));
      },
      true => ()
    );
    i = (i + usize(1));
  });
  n
});

export(count_byte);
```

### 用位标志传递选项集

把一组布尔选项作为一个 `i32` 传递，每个选项是 2 的一个幂（`FLAG_UPPER = 1`、
`FLAG_UNDERSCORE = 2`，下一个是 `4`，……）。Yo 端像 `transform` 那样用
`((flags & FLAG_X) != i32(0))` 测试某一位，JavaScript 端用 `|=` 构造掩码。两边的常量
列表保持相同顺序，并且各自只定义在一处。

## 构建模块

构建库需要 `-sMODULARIZE=1`（让胶水代码成为一个工厂函数，而不是加载即运行的脚本），并显式
列出导出的函数和运行时视图：

```bash
yo compile src/wasm_api.yo --target wasm32-unknown-emscripten --optimize 2 \
  --cflags '-sMODULARIZE=1 -sEXPORT_NAME=createModule -sENVIRONMENT=web,node -sALLOW_MEMORY_GROWTH=1 -sEXPORTED_FUNCTIONS=_wasm_alloc,_wasm_free,_transform -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32' \
  -o npm/my_lib_wasm_api.js
```

同一个产物写成 `build.yo` 步骤（字段和输出格式规则见 [BUILD_SYSTEM.md](./BUILD_SYSTEM.md)）：

```yo
build :: import("std/build");

wasm_api :: build.executable({
  name : "my_lib_wasm_api",
  root : "./src/wasm_api.yo",
  target : build.CompilationTarget.Wasm32_Unknown_Emscripten,
  optimize : build.Optimize.ReleaseSmall,
  allocator : build.AllocatorKind.System
});
wasm_api.add_c_flags("-sMODULARIZE=1 -sEXPORT_NAME=createModule -sENVIRONMENT=web,node -sALLOW_MEMORY_GROWTH=1 -sEXPORTED_FUNCTIONS=_wasm_alloc,_wasm_free,_transform -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32");

install :: build.step("install", "Build the WASM module");
install.depend_on(wasm_api);
```

`yo build` 生成 `yo-out/wasm32-unknown-emscripten/bin/my_lib_wasm_api.js` 和 `.wasm`；
把两者拷贝到 `npm/`。

各个标志的作用：

| 标志 | 原因 |
| --- | --- |
| `-sMODULARIZE=1 -sEXPORT_NAME=createModule` | 胶水代码导出工厂函数 `createModule()`，它返回一个解析为模块的 Promise |
| `-sENVIRONMENT=web,node` | 同一份构建在两处都能加载；只写 `node` 会去掉浏览器部分的代码 |
| `-sALLOW_MEMORY_GROWTH=1` | 不加时堆大小固定（默认 16 MiB），大输入会分配失败 |
| `-sEXPORTED_FUNCTIONS=_name,...` | 每个导出的 Yo 函数，名字前加 `_` |
| `-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32` | 包装层读取的内存视图；用到的每个视图都要导出 |

## npm 包结构

```text
npm/
├── package.json          # 包元数据
├── index.js              # 包装层：加载模块，暴露 API
├── index.d.ts            # TypeScript 声明
├── my_lib_wasm_api.js    # Emscripten 胶水代码（构建产物）
└── my_lib_wasm_api.wasm  # 模块本身（构建产物）
```

`yo compile` 还会在输出旁留下生成的 C 文件（`my_lib_wasm_api.c`）；`files` 列表让它不进入
发布的包。

```json
{
  "name": "my-yo-lib",
  "version": "0.1.0",
  "main": "index.js",
  "types": "index.d.ts",
  "files": ["index.js", "index.d.ts", "my_lib_wasm_api.js", "my_lib_wasm_api.wasm"]
}
```

## JavaScript 包装层

包装层把边界藏起来：只加载一次模块，编码字符串，管理每一次分配，返回普通的 JavaScript 值。

```javascript
// npm/index.js
const createModule = require("./my_lib_wasm_api.js");

const FLAG_UPPER = 1;
const FLAG_UNDERSCORE = 2;

let modulePromise = null;

// Emscripten 异步实例化：只启动一次，共享这个 promise。
function loadModule() {
  if (!modulePromise) modulePromise = createModule();
  return modulePromise;
}

function buildFlags(options) {
  let flags = 0;
  if (options.upper) flags |= FLAG_UPPER;
  if (options.underscore) flags |= FLAG_UNDERSCORE;
  return flags;
}

async function transform(input, options = {}) {
  const mod = await loadModule();
  const bytes = new TextEncoder().encode(input);

  // malloc(0) 可能返回 NULL，所以总是至少申请一个字节。
  const inputPtr = mod._wasm_alloc(Math.max(bytes.length, 1));
  const outLenPtr = mod._wasm_alloc(4); // 一个 wasm32 usize
  if (inputPtr === 0 || outLenPtr === 0) {
    mod._wasm_free(inputPtr);
    mod._wasm_free(outLenPtr);
    throw new Error("wasm_alloc failed");
  }
  try {
    mod.HEAPU8.set(bytes, inputPtr);
    const outPtr = mod._transform(inputPtr, bytes.length, buildFlags(options), outLenPtr);
    if (outPtr === 0) throw new Error("transform: out of memory");
    // 在调用之后再读视图：内存增长会替换 mod.HEAPU8。
    const outLen = mod.HEAPU32[outLenPtr >> 2];
    const result = new TextDecoder().decode(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
    mod._wasm_free(outPtr);
    return result;
  } finally {
    mod._wasm_free(inputPtr);
    mod._wasm_free(outLenPtr);
  }
}

module.exports = { transform };
```

```bash
$ cd npm && node -e "require('.').transform('hello, wasm', { upper: true, underscore: true }).then(console.log)"
HELLO,_WASM
```

## TypeScript 声明

```typescript
// npm/index.d.ts
export interface TransformOptions {
  /** 把结果中的 ASCII 字母转为大写。 */
  upper?: boolean;
  /** 把每个空格替换为 `_`。 */
  underscore?: boolean;
}

export function transform(input: string, options?: TransformOptions): Promise<string>;
```

函数是 `async` 的，因为模块实例化是异步的。

## 传递字符串

WebAssembly 只看得到字节。在边界上由 JavaScript 负责 UTF-8 的编码与解码，传递指针和字节长度；
不要传 JavaScript 字符串的长度，那是 UTF-16 码元的个数。

从 JavaScript 到模块：

```javascript
const bytes = new TextEncoder().encode(str);
const ptr = mod._wasm_alloc(Math.max(bytes.length, 1));
mod.HEAPU8.set(bytes, ptr);
// 传入 ptr 和 bytes.length；调用结束后释放 ptr
```

从模块到 JavaScript：

```javascript
// 结果是指针加长度。
function readString(mod, ptr, len) {
  return new TextDecoder().decode(mod.HEAPU8.subarray(ptr, ptr + len));
}

// 长度写在 lenPtr 处的 usize 槽位中（wasm32 上为 4 字节）。
function readStringWithStoredLength(mod, ptr, lenPtr) {
  return readString(mod, ptr, mod.HEAPU32[lenPtr >> 2]);
}
```

如果 Yo 函数改为写出以 NUL 结尾的字符串，读取方就得自己扫描 `0` 字节；显式长度更简单，
也允许数据中包含 NUL。

## 测试

先在原生平台上调试。同一套 API 可以为宿主机编译，AddressSanitizer 会在出错的源头报告坏指针；
wasm 构建没有 sanitizer（C 编译器为 `emcc` 时 `--sanitize` 会被忽略）。原生冒烟测试以
JavaScript 将要使用的方式调用 API：

```yo
// src/smoke.yo
//! WASM API 的原生冒烟测试：先在 AddressSanitizer 下运行。
pragma(Pragma.AllowUnsafe);

{ println } :: import("std/fmt");
{ wasm_free, transform } :: import("./wasm_api.yo");

main :: (fn() -> unit)({
  input := "hello wasm";
  (out_len : usize) = usize(0);
  match(
    transform(input.ptr(), input.len(), i32(3), &out_len),
    .Some(p) => {
      println(str.from_raw_parts(p, out_len));
      wasm_free(.Some(p));
    },
    .None => println("out of memory")
  );
});

export(main);
```

```bash
# 原生构建，启用 AddressSanitizer
yo compile src/smoke.yo --optimize 2 --sanitize address --allocator system -o smoke && ./smoke

# 同一程序作为独立的 WASI 模块
yo compile src/smoke.yo --target wasm32-wasip1 --optimize 2 -o smoke.wasm && wasmtime smoke.wasm

# 通过 npm 包装层调用库
cd npm && node -e "require('.').transform('hello').then(console.log)"
```

原生构建和 WASI 构建都输出 `HELLO_WASM`。

## 常见陷阱

- **释放每一次分配。** 每个 `_wasm_alloc` 都需要对应的 `_wasm_free`，函数返回的每块内存也一样。
  包装层中的 `try`/`finally` 能防止异常导致输入缓冲区泄漏。
- **不要跨调用缓存内存视图。** 启用 `-sALLOW_MEMORY_GROWTH` 时，堆增长会替换
  `ArrayBuffer`，调用前保存的 `HEAPU8` 会失效。在调用之后再读 `mod.HEAPU8` / `mod.HEAPU32`。
- **`malloc(0)` 可能返回 NULL。** 边界两侧都至少申请一个字节，免得把空输入误判为分配失败。
- **`usize` 在 wasm32 上是 4 字节，在 64 位宿主机上是 8 字节。** 包装层用 `HEAPU32`
  读取的长度槽位只适用于 wasm32。
- **模块初始化是异步的。** `createModule()` 返回 Promise：只创建一次并共享。
- **`-sENVIRONMENT`** 决定胶水代码能在哪里加载：`web,node` 表示两者皆可，`node` 表示仅 Node.js。
- **决定 emcc 输出格式的是输出文件扩展名，而不是 `--target`。** `-o out.js` 生成胶水代码
  和同名 `.wasm`，`-o out.wasm` 生成独立模块。不带扩展名时，Emscripten 构建写出
  `out.html` + `out.js` + `out.wasm`，WASI 构建写出 `out.wasm`。无法识别的扩展名
  （如 `-o out.bin`）即使在 `--target wasm32-wasip1` 下也会得到 JavaScript，并在很久之后
  有程序试图执行它时才以 `permission denied` 失败。用 `file <artifact>` 检查（`issues/a-wasip1-build-with-an-unrecognized-output-extension-writes-javascript.md`）。
- **wasm 产物不是可执行文件。** WASI 模块在 `wasmtime` 下运行，它默认拒绝一切访问：
  用 `--dir` 逐个授权目录，用 `--env` 传入环境变量。Emscripten 胶水代码用 `node` 运行。
- **WASI 与 POSIX 的 errno 值不同。** 使用 `std/libc/errno` 中的常量，或 `std/sys/errors`
  映射出的 `IoError`，不要硬编码数字。
