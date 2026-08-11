import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { Arch, type BeforePackContext, type Configuration } from "electron-builder"

import { BRANDS, MAIN_BRAND_ID, resolveBrandIdFromEnv } from "@opencode-ai/brand/table"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const signScript = path.join(rootDir, "script", "sign-windows.ps1")

// electron-builder 默认对 win-unpacked 下所有 .exe 都回调 sign 钩子，
// 包括 app.asar.unpacked/ 里第三方 native module 自带的 binary（例如
// @lydell/node-pty 带的 OpenConsole.exe）。evsign 服务端只签经过审核
// 的自家产物，对未审核的第三方 binary 会以 "此文件未审核" 拒签退 1。
// 用白名单只签自家产物（与 publish.yml verify step 的 glob 一一对应）：
//   dist/*.exe                  installer 类（NSIS Setup.exe 等）
//   dist/<name>-unpacked/*.exe  主 app 程序（万来Codex.exe）
// 其他一律 skip（包括 opencode-cli.exe、第三方 native module binary）。
function shouldSignWindowsArtifact(absPath: string): boolean {
  const norm = absPath.replace(/\\/g, "/")
  const m = norm.match(/\/dist\/(.+)$/)
  if (!m) return false
  const parts = m[1].split("/")
  if (parts.length === 1 && parts[0].endsWith(".exe")) return true
  if (parts.length === 2 && parts[0].endsWith("-unpacked") && parts[1].endsWith(".exe")) return true
  return false
}

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return
  // 无 SignClient key 时直接跳过，避免 spawn pwsh ENOENT；
  // sign-windows.ps1 内部本来也会基于 SIGNCLIENT_KEY env exit 0，但 pwsh 不存在时根本进不去。
  if (!process.env.SIGNCLIENT_KEY) return

  if (!shouldSignWindowsArtifact(configuration.path)) {
    console.log(`[signWindows] skip third-party binary: ${configuration.path}`)
    return
  }

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const NODE_PTY_PLATFORMS: Record<string, string> = {
  darwin: "darwin",
  win32: "win32",
  linux: "linux",
}
const NODE_PTY_ARCHS: Partial<Record<Arch, string>> = {
  [Arch.x64]: "x64",
  [Arch.arm64]: "arm64",
}

// @lydell/node-pty 通过 npm optionalDependencies 按 cpu/os 分发平台包。
// 宿主侧 `bun install --cpu=<host>` 只装了 host 架构那份；交叉打 target arch 时
// 需要把 target 平台包补装进 node_modules,否则 electron-builder 会把 host arch
// 的二进制打入 target arch 包。
async function ensureNodePtyForTarget(context: BeforePackContext) {
  const targetPlatform = NODE_PTY_PLATFORMS[context.electronPlatformName]
  const targetArch = NODE_PTY_ARCHS[context.arch]
  if (!targetPlatform || !targetArch) return

  const pkgDirName = `node-pty-${targetPlatform}-${targetArch}`
  const pkgFullName = `@lydell/${pkgDirName}`
  const dest = path.join(rootDir, "node_modules", "@lydell", pkgDirName)
  if (fs.existsSync(path.join(dest, "package.json"))) return

  const desktopPkg = JSON.parse(await fs.promises.readFile(path.join(desktopDir, "package.json"), "utf8"))
  const version = desktopPkg.optionalDependencies?.[pkgFullName]
  if (!version) throw new Error(`No version declared for ${pkgFullName} in desktop/package.json`)

  const tar = process.platform === "win32" ? "tar.exe" : "tar"
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "node-pty-cross-"))
  const packArgs = [
    "pack",
    `${pkgFullName}@${version}`,
    "--pack-destination",
    tmpDir,
    "--json",
  ]
  const npmEnv = { ...process.env, npm_config_cache: path.join(tmpDir, "npm-cache") }
  try {
    const { stdout } =
      process.platform === "win32"
        ? await execFileAsync("cmd.exe", ["/d", "/s", "/c", "npm", ...packArgs], { env: npmEnv })
        : await execFileAsync("npm", packArgs, { env: npmEnv })
    const meta = JSON.parse(stdout) as Array<{ filename: string }>
    const tarball = path.join(tmpDir, meta[0].filename)
    await fs.promises.mkdir(dest, { recursive: true })
    await execFileAsync(tar, ["-xzf", tarball, "-C", dest, "--strip-components=1"])
    console.log(`[beforePack] installed ${pkgFullName}@${version} (${targetPlatform}/${targetArch})`)
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  }
}

const channel = (() => {
  const raw = (process.env.WANLAICODE_CHANNEL ?? process.env.OPENCODE_CHANNEL)
  if (raw === "dev" || raw === "beta" || raw === "canary" || raw === "prod") return raw
  return "dev"
})()

// Brand 切换由 WANLAICODE_BRAND 控制（默认 wanlai），决定 productName / artifactName /
// S3 channel 路径。brand 字面量统一从 @opencode-ai/brand/table 拿（单 source of truth）；
// 该子模块是纯 Node-loadable 数据（不含 import.meta），electron-builder 的 esbuild loader 能直接加载。
// appId / protocols.schemes / deb.packageName / rpm.packageName 在两 brand 间一致，让两包"互装即覆盖"。
// deb.packageName 必须显式给：package.json name 是 @scope 形式，electron-builder 的
// linuxPackageName 会回退用 sanitizedProductName（中文 productName "万来Code"），
// 生成非法 Debian 包名（非 [a-z0-9] 开头），dpkg --install 会拒装。
// linux.executableName 同理必须显式给 ASCII：mac/win 的 executableName 默认走 productName，
// 但 Linux 默认回退到 package.json name（@wanlaicode-ai/desktop），sanitize 后成
// "@wanlaicode-aidesktop"，`@` 是 AppImage 文件路径非法字符，构建直接中断。
// 值与 deb/rpm.packageName 对齐（prod/dev=wanlaicode、beta=wanlaicode-beta），避免 beta 与
// prod 的 deb 同机共存时 /usr/bin 下二进制基名重名冲突。
const brandId = resolveBrandIdFromEnv(process.env)
// 未知 brand 安全 fallback（resolveBrandIdFromEnv 已经做了 fallback，这里二次防御让 BRANDS[id]
// 一定可索引出值，避免后面 brandInfo.nameCn 之类的访问 undefined）。
const brandInfo = BRANDS[brandId] ?? BRANDS[MAIN_BRAND_ID]

// S3 兼容存储（自部署 MinIO）的 publish 配置，env 由 publish.yml 注入：
// S3_ENDPOINT  例：https://minio.example.com
// S3_BUCKET    例：desktop-releases
// S3_REGION    可选，MinIO 任意值，默认 us-east-1
//
// 注意：publish.path 同时锁定两件事 —— (1) electron-builder 自带 publish 的上传位置，
// (2) baked 进 app-update.yml 的 auto-updater 拉取位置。两者必须都是 live <channel>/，
// 否则装好的 app 会去版本目录查更新、永远看不到下一版。
// 因此本工程的 build 阶段统一 --publish never，让 electron-builder 只产物不上传；
// 实际上传由 upload-staging-s3.ts 推到 <channel>/<version>/ staging，等所有平台都成功
// 再由 promote-s3.ts server-side copy 到 <channel>/ 根，做跨平台原子切换。
const s3Endpoint = process.env.S3_ENDPOINT
const s3Bucket = process.env.S3_BUCKET
const s3Region = process.env.S3_REGION ?? "us-east-1"

// 历史 GitHub provider 配置（已弃用，切到 S3）。注释保留方便上游同步对比。
// const [publishOwner, publishRepo] = (process.env.GH_REPO ?? "ymquant/wanlaicode").split("/")

const getBase = (): Configuration => ({
  // ASCII-only 文件名：GitHub Release API 会丢弃非 ASCII 字符（"万来" 被删），
  // 导致 S3 上的中文名 / GH Release 上的截短名不一致。用 ASCII 让两边对齐；
  // app 内部的 productName / DMG 卷标 / installer 标题 baked 进资源仍是 "万来Code"。
  artifactName: brandInfo.artifactPrefix + "-desktop-${os}-${arch}.${ext}",
  beforePack: ensureNodePtyForTarget,
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: [
    "out/**/*",
    "resources/**/*",
    // installer.nsh 是构建期 NSIS include(见 nsis 配置注释)，运行时不需要，排除出 app.asar。
    "!resources/installer.nsh",
    "!resources/builtin-skills/**",
  ],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: [
        "index.js",
        "index.d.ts",
        "build/Release/mac_window.node",
        "swift-build/**",
        "!swift-build/module-cache/**",
      ],
    },
    // 运行时按 process.resourcesPath/icons 读取 dock.png / icon.icns 等（windows.ts、apps.ts）。
    // files 里的 resources/** 只进了 app.asar 内部，取不到；必须以 extraResources 落到 Contents/Resources/icons。
    // 缺这一项会导致打包版 app.dock.setIcon(dock.png) 静默失败、回退显示 bundle .icns，图标与 dev 不一致。
    {
      from: "resources/icons",
      to: "icons",
      filter: ["*.png", "*.icns", "*.ico"],
    },
    // 内置 skill —— Desktop 首启通过 WANLAICODE_BUILTIN_SKILLS_DIR env 注入,
    // discoverSkills 扫描加载。源在 resources/builtin-skills/,产物进 git。
    {
      from: "resources/builtin-skills",
      to: "builtin-skills",
      filter: ["**/*"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    // 无 Apple 证书时 identity 显式设 null，让 electron-builder 完全跳过 .app 签名。
    // 仅设 dmg.sign / mac.notarize 还不够：CSC_LINK env 即使空字符串也会让它进 signing 路径
    // 触发 "packages/desktop not a file" fatal。null 是 electron-builder 的明示不签信号。
    identity: process.env.CSC_LINK ? undefined : null,
    // 触发公证的开关同时兼容两条凭证路线（@electron/notarize 内部按 env 自动选）：
    //   1. APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER  (App Store Connect API Key)
    //   2. APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID  (Apple ID 专用密码)
    notarize: !!(process.env.APPLE_API_KEY_ID || process.env.APPLE_TEAM_ID),
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: !!process.env.CSC_LINK,
  },
  protocols: {
    name: brandInfo.nameCn,
    schemes: ["wanlaicode"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    // 卸载强制反馈的 customUnInit 宏定义在 resources/installer.nsh。electron-builder
    // 默认会从 buildResources(=resources/) 以 !addincludedir 引入该文件并展开其中的自定义宏，
    // 因此这里无需显式配置 include/script —— 放对文件位置即生效（见 installer.nsh 顶部说明）。
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    // 开启 electron-builder 默认 app-data 清理；桌面端实际 appData/appId
    // userData 目录由 resources/installer.nsh 的 customUnInstall 补删。
    deleteAppDataOnUninstall: true,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

// path 固定走 live <channel>/，绝不带版本号 —— 这个值会被 baked 进 app-update.yml，
// 装好的 app 永远从这里查 latest*.yml。实际上传位置由 upload-staging-s3.ts 独立控制。
// S3_ENDPOINT / S3_BUCKET 没注入时 publish=null 完全关闭上传（本地 --publish never 不进这条）。
function s3Publish(channelPath: string) {
  if (!s3Endpoint || !s3Bucket) return null
  // 跟 scripts/utils.ts:resolveChannelPath 的规则对齐：main brand 走 plain channel
  // （prod / beta）以兼容现网；sub-brand 拼 `-<brand>` 后缀（prod-codex / beta-codex）。
  // 硬编码 "codex" 会让未来加 brand 时这里 fallthrough 算成 main channel，跟
  // upload-staging-s3.ts 写入的 <channel>-<brand>/ 错位，错盖主 brand 的 latest.yml。
  const path = brandId === MAIN_BRAND_ID ? channelPath : `${channelPath}-${brandId}`
  return {
    provider: "s3" as const,
    endpoint: s3Endpoint,
    region: s3Region,
    bucket: s3Bucket,
    path,
    channel: "latest",
  }
}

function getConfig() {
  const base = getBase()
  const productName = brandInfo.nameCn

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "ai.wanlaicode.desktop",
        productName,
        linux: { ...base.linux, executableName: "wanlaicode" },
        deb: { packageName: "wanlaicode" },
        rpm: { packageName: "wanlaicode" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.wanlaicode.desktop.beta",
        productName: `${productName} Beta`,
        protocols: { name: `${productName} Beta`, schemes: ["wanlaicode"] },
        publish: s3Publish("beta"),
        linux: { ...base.linux, executableName: "wanlaicode-beta" },
        deb: { packageName: "wanlaicode-beta" },
        rpm: { packageName: "wanlaicode-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.wanlaicode.desktop",
        productName,
        protocols: { name: productName, schemes: ["wanlaicode"] },
        publish: s3Publish("prod"),
        linux: { ...base.linux, executableName: "wanlaicode" },
        deb: { packageName: "wanlaicode" },
        rpm: { packageName: "wanlaicode" },
      }
    }
    // B-pure：候选改用 prod 构建(见 publish.yml,烤 path=prod),此 case 已不由 CI 触发,仅留手动构建兼容。
    case "canary": {
      // canary 与 prod 是同一个 App：appId / productName / protocols 完全一致，
      // 仅 S3 publish 路径指向 canary/，让同一装置能通过更新机制切到 canary 版本。
      return {
        ...base,
        appId: "ai.wanlaicode.desktop",
        productName,
        protocols: { name: productName, schemes: ["wanlaicode"] },
        publish: s3Publish("canary"),
        linux: { ...base.linux, executableName: "wanlaicode" },
        deb: { packageName: "wanlaicode" },
        rpm: { packageName: "wanlaicode" },
      }
    }
  }
}

export default getConfig()
