import { describe, it, expect } from "bun:test";
import { renderDocJson } from "./render-json";
import type { DocModel } from "./model";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function makeModel(): DocModel {
  return {
    name: "test-project",
    modules: [
      {
        name: "math",
        path: "std/math",
        doc: "Math utilities.",
        functions: [
          {
            name: "add",
            signature: "add :: (fn(a : i32, b : i32) -> i32)",
            doc: "Add two numbers.",
            parameters: [
              { name: "a", type: "i32", isComptime: false, isImplicit: false },
              { name: "b", type: "i32", isComptime: false, isImplicit: false },
            ],
            returnType: "i32",
            isMethod: false,
          },
        ],
        types: [
          {
            name: "Point",
            kind: "struct",
            signature: "Point :: struct(x : i32, y : i32)",
            doc: "A 2D point.",
            fields: [
              { name: "x", type: "i32" },
              { name: "y", type: "i32" },
            ],
            typeParams: [],
            traitImpls: ["Display"],
            methods: [],
          },
        ],
        traits: [],
        constants: [],
        submodules: [],
      },
    ],
  };
}

describe("renderDocJson", () => {
  it("writes a doc.json file with pretty formatting", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-doc-json-"));
    try {
      const model = makeModel();
      renderDocJson({ model, outputDir: tmpDir });

      const jsonPath = path.join(tmpDir, "doc.json");
      expect(fs.existsSync(jsonPath)).toBe(true);

      const content = fs.readFileSync(jsonPath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.name).toBe("test-project");
      expect(parsed.modules).toHaveLength(1);
      expect(parsed.modules[0].name).toBe("math");
      expect(parsed.modules[0].functions).toHaveLength(1);
      expect(parsed.modules[0].types).toHaveLength(1);

      // Pretty-printed has newlines
      expect(content).toContain("\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes compact JSON when pretty=false", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-doc-json-"));
    try {
      const model = makeModel();
      renderDocJson({ model, outputDir: tmpDir, pretty: false });

      const content = fs.readFileSync(path.join(tmpDir, "doc.json"), "utf-8");
      // Compact JSON should be a single line
      expect(content.split("\n")).toHaveLength(1);

      const parsed = JSON.parse(content);
      expect(parsed.name).toBe("test-project");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves all model fields", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-doc-json-"));
    try {
      const model = makeModel();
      renderDocJson({ model, outputDir: tmpDir });

      const parsed = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "doc.json"), "utf-8")
      );

      const fn = parsed.modules[0].functions[0];
      expect(fn.name).toBe("add");
      expect(fn.doc).toBe("Add two numbers.");
      expect(fn.parameters).toHaveLength(2);
      expect(fn.returnType).toBe("i32");

      const type = parsed.modules[0].types[0];
      expect(type.name).toBe("Point");
      expect(type.kind).toBe("struct");
      expect(type.fields).toHaveLength(2);
      expect(type.traitImpls).toContain("Display");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates output directory if not exists", () => {
    const tmpDir = path.join(
      os.tmpdir(),
      `yo-doc-json-${Date.now()}-nested`,
      "deep"
    );
    try {
      renderDocJson({ model: makeModel(), outputDir: tmpDir });
      expect(fs.existsSync(path.join(tmpDir, "doc.json"))).toBe(true);
    } finally {
      fs.rmSync(path.dirname(tmpDir), { recursive: true, force: true });
    }
  });
});
