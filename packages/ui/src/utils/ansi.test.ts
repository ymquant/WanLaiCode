import { describe, expect, test } from "bun:test"
import { langFromFilePath } from "./ansi"

describe("langFromFilePath", () => {
  test("matches special filenames before extensions", () => {
    expect(langFromFilePath("Dockerfile")).toBe("dockerfile")
    expect(langFromFilePath("docker/Dockerfile.dev")).toBe("dockerfile")
    expect(langFromFilePath("Makefile")).toBe("make")
    expect(langFromFilePath("cmake/CMakeLists.txt")).toBe("cmake")
  })

  test("supports dotfiles and extension fallback", () => {
    expect(langFromFilePath(".env")).toBe("env")
    expect(langFromFilePath(".env.local")).toBe("env")
    expect(langFromFilePath("config/.gitignore")).toBe("gitignore")
    expect(langFromFilePath("src/example.ts")).toBe("typescript")
  })
})
