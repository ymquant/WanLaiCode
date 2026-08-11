import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { submitUninstallFeedback } from "./submit"

const baseInput = {
  content: "经常卡顿换工具了",
  contact: "u@e.com",
  images: [{ name: "a.png", type: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
  meta: { client: "wanlai", clientVersion: "0.0.24", os: "win32", arch: "x64" },
}

describe("submitUninstallFeedback", () => {
  test("success: posts multipart and returns id", async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(JSON.stringify({ code: 0, data: { id: "rid" } }), { status: 200 })
    }) as unknown as typeof fetch

    const dir = mkdtempSync(join(tmpdir(), "uf-"))
    try {
      const res = await submitUninstallFeedback(baseInput, {
        fetch: fakeFetch,
        apiBase: "https://api.example.com/v1",
        fallbackDir: dir,
        stamp: "S1",
      })
      expect(res).toEqual({ ok: true, id: "rid", fellBack: false })
      expect(captured!.url).toBe("https://api.example.com/api/v1/software/uninstall-feedback")
      const form = captured!.init.body as FormData
      expect(form.get("content")).toBe("经常卡顿换工具了")
      expect(form.getAll("images").length).toBe(1)
      expect(readdirSync(dir).length).toBe(0) // no fallback written on success
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("network error → writes fallback and returns not ok", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const dir = mkdtempSync(join(tmpdir(), "uf-"))
    try {
      const res = await submitUninstallFeedback(baseInput, {
        fetch: fakeFetch,
        apiBase: "https://api.example.com/v1",
        fallbackDir: dir,
        stamp: "S2",
      })
      expect(res.ok).toBe(false)
      expect(res.fellBack).toBe(true)
      expect(readdirSync(dir).length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("non-ok HTTP response → writes fallback and returns fellBack true", async () => {
    const fakeFetch = (async () => {
      return new Response(JSON.stringify({ code: 5, message: "s3 down" }), { status: 503 })
    }) as unknown as typeof fetch
    const dir = mkdtempSync(join(tmpdir(), "uf-"))
    try {
      const res = await submitUninstallFeedback(baseInput, {
        fetch: fakeFetch,
        apiBase: "https://api.example.com/v1",
        fallbackDir: dir,
        stamp: "S3",
      })
      expect(res.ok).toBe(false)
      expect(res.fellBack).toBe(true)
      expect(readdirSync(dir).length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fallback write failure → never throws, returns ok:false fellBack:false", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const dir = mkdtempSync(join(tmpdir(), "uf-"))
    try {
      // 把一个普通文件当作 fallbackDir 的父级 → mkdir 必然 ENOTDIR，模拟写盘失败。
      const file = join(dir, "not-a-dir")
      writeFileSync(file, "x")
      const res = await submitUninstallFeedback(baseInput, {
        fetch: fakeFetch,
        apiBase: "https://api.example.com/v1",
        fallbackDir: join(file, "sub"),
        stamp: "S4",
      })
      expect(res).toEqual({ ok: false, fellBack: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
