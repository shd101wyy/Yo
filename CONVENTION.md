- Type

| \\                                                           | Tuple | Struct/Enum/Union | Function | Interface |
| ------------------------------------------------------------ | ----- | ----------------- | -------- | --------- |
| labelled parameter                                           | ✅    | ✅                | ✅       | ✅        |
| parameter default value (compt only)                         | ❌    | ✅                | ❌       | ✅        |
| parameter type uses previous parameter value (comptime only) | ❌    | ❌                | ✅       | ✅        |

- Value

| \\                | Create Tuple Value | Create Struct/Enum/Union Value | Call Function | Impl Interface |
| ----------------- | ------------------ | ------------------------------ | ------------- | -------------- |
| labelled argument | ❌                 | ✅                             | ❌            | ✅             |
