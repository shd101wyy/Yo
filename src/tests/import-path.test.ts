import { describe, test, expect } from "bun:test";
import path from "path";
import { safeRelativePath } from "../evaluator/exprs/import";

describe("safeRelativePath", () => {
  describe("Windows cross-drive paths (path.win32)", () => {
    test("returns absolute path when source and target are on different drives", () => {
      const fromDir = "D:\\a\\markdown_yo\\markdown_yo";
      const toPath =
        "C:\\npm\\prefix\\node_modules\\@shd101wyy\\yo\\std\\build.yo";

      const result = safeRelativePath(fromDir, toPath, path.win32);

      // Should return the absolute target path, not a broken relative path
      expect(result).toBe(toPath);
      expect(path.win32.isAbsolute(result)).toBe(true);
    });

    test("returns absolute path for std library import across drives", () => {
      const fromDir = "D:\\a\\project";
      const stdPath = "C:\\npm\\node_modules\\yo\\std";
      const resolvedStdModule = path.win32.resolve(
        stdPath,
        ".\\collections\\array_list"
      );

      const result = safeRelativePath(fromDir, resolvedStdModule, path.win32);

      expect(result).toBe(resolvedStdModule);
      expect(path.win32.isAbsolute(result)).toBe(true);
    });

    test("returns relative path when on the same drive", () => {
      const fromDir = "C:\\Users\\user\\project";
      const toPath = "C:\\Users\\user\\project\\std\\build.yo";

      const result = safeRelativePath(fromDir, toPath, path.win32);

      expect(result).toBe("./std\\build.yo");
      expect(path.win32.isAbsolute(result)).toBe(false);
    });

    test("returns relative path with ../ when target is a sibling directory", () => {
      const fromDir = "C:\\Users\\user\\project\\src";
      const toPath = "C:\\Users\\user\\project\\std\\build.yo";

      const result = safeRelativePath(fromDir, toPath, path.win32);

      expect(result).toBe("..\\std\\build.yo");
    });
  });

  describe("POSIX paths (path.posix)", () => {
    test("returns relative path for same filesystem", () => {
      const fromDir = "/home/user/project";
      const toPath = "/home/user/.npm/node_modules/yo/std/build.yo";

      const result = safeRelativePath(fromDir, toPath, path.posix);

      expect(result).toBe("../.npm/node_modules/yo/std/build.yo");
      expect(path.posix.isAbsolute(result)).toBe(false);
    });

    test("prepends ./ when relative path has no dot prefix", () => {
      const fromDir = "/home/user/project";
      const toPath = "/home/user/project/std/build.yo";

      const result = safeRelativePath(fromDir, toPath, path.posix);

      expect(result).toBe("./std/build.yo");
    });
  });
});
