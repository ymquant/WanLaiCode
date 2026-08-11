import { beforeEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createThemeContext } from "./context"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const elements = new Map<string, TestElement>()

class TestElement {
  textContent: string | null = null
  dataset: Record<string, string> = {}
  private elementId = ""

  get id() {
    return this.elementId
  }

  set id(value: string) {
    this.elementId = value
    if (value) elements.set(value, this)
  }

  set innerHTML(_: string) {
    elements.clear()
  }

  appendChild<T extends Node>(child: T) {
    return child
  }

  remove() {
    if (this.elementId) elements.delete(this.elementId)
  }

  removeAttribute(name: string) {
    if (name === "data-theme") delete this.dataset.theme
    if (name === "data-color-scheme") delete this.dataset.colorScheme
  }
}

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

Object.defineProperty(globalThis, "document", {
  value: {
    head: new TestElement(),
    documentElement: new TestElement(),
    createElement: () => new TestElement(),
    getElementById: (id: string) => elements.get(id) ?? null,
  },
  configurable: true,
})

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
})

Object.defineProperty(globalThis, "window", {
  value: {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  },
  configurable: true,
})

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
    configurable: true,
  })
})

describe("ThemeProvider system color scheme sync", () => {
  test("rechecks native system mode when switching back to system", async () => {
    let mode: "light" | "dark" = "light"

    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        localStorage.setItem("opencode-color-scheme", "light")
        // 这里直接创建真实主题上下文，验证用户切回 system 后会读取 Electron nativeTheme 的真实深浅色。
        const theme = createThemeContext({
          getSystemMode: () => mode,
        })

        expect(theme.mode()).toBe("light")
        mode = "dark"
        theme.setColorScheme("system")

        void flush().then(() => {
          expect(theme.colorScheme()).toBe("system")
          expect(theme.mode()).toBe("dark")
          dispose()
          resolve()
        })
      })
    })
  })
})
