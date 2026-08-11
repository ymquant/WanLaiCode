// 以 --uninstall-feedback 模式启动 desktop dev，用于本地预览卸载反馈窗口。
//
// 为什么需要独立脚本：`bun run` 会把脚本字符串里的 `--` 当成自己的 flag 分隔符解析，
// 嵌套写法（bun run dev -- -- --flag / bun run x && electron-vite dev -- --flag）都会触发
// "Usage: bun run"。这里改用 Bun.spawn 以数组传参，`--` 作为独立 argv 元素直接交给
// electron-vite（它再把 `--` 之后的参数透传到 Electron 主进程的 process.argv），彻底避开
// bun 的 `--` 解析。
import { $ } from "bun"

// 与 `dev` 的 predev 预处理对齐（copy-icons + build addon/opencode）。
await $`bun ./scripts/predev.ts`

const proc = Bun.spawn(["./node_modules/.bin/electron-vite", "dev", "--", "--uninstall-feedback"], {
  stdio: ["inherit", "inherit", "inherit"],
})

process.exit(await proc.exited)
