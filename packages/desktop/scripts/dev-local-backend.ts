import { $ } from "bun"

// 本地后端模式先执行与普通 dev 相同的资源预构建，再把 OAuth、刷新和模型 API 显式指向本机服务。
await $`bun ./scripts/predev.ts`

const child = Bun.spawn(["./node_modules/.bin/electron-vite", "dev"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    WANLAICODE_API_BASE: process.env.WANLAICODE_API_BASE ?? "http://127.0.0.1:8080/v1",
    WANLAICODE_SITE_URL: process.env.WANLAICODE_SITE_URL ?? "http://127.0.0.1:3001",
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

// 包装脚本必须把终端退出信号转交给 electron-vite，否则 Ctrl+C 后 Electron 与 sidecar 会残留。
const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal)
const interrupt = () => forwardSignal("SIGINT")
const terminate = () => forwardSignal("SIGTERM")
process.once("SIGINT", interrupt)
process.once("SIGTERM", terminate)

const exitCode = await child.exited
process.off("SIGINT", interrupt)
process.off("SIGTERM", terminate)
process.exit(exitCode)
