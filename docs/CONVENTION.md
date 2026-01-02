- Type

| \\                                                           | Tuple | Struct/Enum/Union | Function | Module |
| ------------------------------------------------------------ | ----- | ----------------- | -------- | ------ |
| labelled parameter                                           | ✅    | ✅                | ✅       | ✅     |
| parameter default value (compt-only)                         | ❌    | ✅                | ✅       | ✅     |
| parameter type uses previous parameter value (comptime-only) | ❌    | ❌                | ✅       | ✅     |

- Value

| \\                | Create Tuple Value | Create Struct/Enum/Union Value | Call Function                              | Module instance |
| ----------------- | ------------------ | ------------------------------ | ------------------------------------------ | --------------- |
| labelled argument | ❌                 | ✅                             | ❌ (Can use label at the matched position) | ✅              |