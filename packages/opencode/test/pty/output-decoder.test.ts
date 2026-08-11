import { describe, expect, test } from "bun:test"
import { createPtyOutputDecoder } from "../../src/pty/output-decoder"

describe("pty output decoder", () => {
  test("keeps utf-8 text unchanged", () => {
    const decoder = createPtyOutputDecoder()

    expect(decoder.decode(Buffer.from("中文输出: 你好，运行日志", "utf8"))).toBe("中文输出: 你好，运行日志")
    expect(decoder.flush()).toBe("")
  })

  test("buffers split utf-8 characters", () => {
    const decoder = createPtyOutputDecoder()
    const bytes = Buffer.from("你好", "utf8")

    expect(decoder.decode(bytes.subarray(0, 1))).toBe("")
    expect(decoder.decode(bytes.subarray(1, 4))).toBe("你")
    expect(decoder.decode(bytes.subarray(4))).toBe("好")
    expect(decoder.flush()).toBe("")
  })

  test("falls back to gb18030 for non-utf8 Chinese output", () => {
    const decoder = createPtyOutputDecoder()

    expect(decoder.decode(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]))).toBe("你好")
    expect(decoder.flush()).toBe("")
  })

  test("detects gb18030 Chinese bytes that are valid utf-8", () => {
    const decoder = createPtyOutputDecoder()

    expect(decoder.decode(new Uint8Array([0xce, 0xa2, 0xd0, 0xc5]))).toBe("微信")
    expect(decoder.flush()).toBe("")
  })

  test("buffers split gb18030 text that starts with valid utf-8 bytes", () => {
    const decoder = createPtyOutputDecoder()

    expect(decoder.decode(new Uint8Array([0xce, 0xa2]))).toBe("")
    expect(decoder.decode(new Uint8Array([0xd0, 0xc5]))).toBe("微信")
    expect(decoder.flush()).toBe("")
  })

  test("bridges gb18030 text that starts with a valid utf-8 pair", () => {
    const decoder = createPtyOutputDecoder()

    expect(decoder.decode(new Uint8Array([0x70, 0x61, 0x74, 0x68, 0x3a, 0x20, 0xc2, 0xb7, 0xbe, 0xb6]))).toBe(
      "path: 路径",
    )
    expect(decoder.flush()).toBe("")
  })

  test("buffers split gb18030 tail after ascii prefix", () => {
    const decoder = createPtyOutputDecoder()

    expect(decoder.decode(new Uint8Array([0x70, 0x61, 0x74, 0x68, 0x3a, 0x20, 0xc2, 0xb7]))).toBe("path: ")
    expect(decoder.decode(new Uint8Array([0xbe, 0xb6]))).toBe("路径")
    expect(decoder.flush()).toBe("")
  })

  test("buffers gb18030 file names split into single bytes", () => {
    const decoder = createPtyOutputDecoder()

    expect(
      [
        0x64, 0x61, 0x69, 0x6c, 0x79, 0x2e, 0x6a, 0x73, 0x6f, 0x6e, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0xce,
        0xc4, 0xbc, 0xfe, 0xc3, 0xfb, 0x20, 0xb2, 0xe2, 0xca, 0xd4, 0x2e, 0x6d, 0x64,
      ].reduce((output, byte) => output + decoder.decode(new Uint8Array([byte])), "") + decoder.flush(),
    ).toBe("daily.json 中文文件名 测试.md")
  })

  test("keeps utf-8 symbols that could be gb18030 Chinese", () => {
    const decoder = createPtyOutputDecoder()

    expect(decoder.decode(Buffer.from("Ω", "utf8"))).toBe("")
    expect(decoder.flush()).toBe("Ω")
  })

  test("keeps valid utf-8 prefix before gb18030 fallback", () => {
    const decoder = createPtyOutputDecoder()
    const prefix = Buffer.from("UTF-8: 你好; GBK: ", "utf8")
    const bytes = new Uint8Array([...prefix, 0xc4, 0xe3, 0xba, 0xc3])

    expect(decoder.decode(bytes)).toBe("UTF-8: 你好; GBK: 你好")
  })

  test("preserves ansi control sequences around fallback text", () => {
    const decoder = createPtyOutputDecoder()

    expect(
      decoder.decode(new Uint8Array([0x1b, 0x5b, 0x33, 0x32, 0x6d, 0xc4, 0xe3, 0xba, 0xc3, 0x1b, 0x5b, 0x30, 0x6d])),
    ).toBe("\x1b[32m你好\x1b[0m")
  })
})
