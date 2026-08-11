import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { Shell } from "../../src/shell/shell"
import { ShellTool } from "../../src/tool/shell"
import { BashOutputTool } from "../../src/tool/bash-output"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { Filesystem } from "@/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session/session"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Plugin } from "../../src/plugin"
import { ShellBackground, MAX_PER_SESSION } from "../../src/tool/shell/background"

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
    Config.defaultLayer,
    Agent.defaultLayer,
    Session.defaultLayer,
    ShellBackground.defaultLayer,
  ),
)

function initBash() {
  return runtime.runPromise(ShellTool.pipe(Effect.flatMap((info) => info.init())))
}

const initShell = initBash

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const bash = (() => {
  const shell = Shell.acceptable()
  if (Shell.name(shell) === "bash") return shell
  return Shell.gitbash()
})()
const shells = (() => {
  if (process.platform !== "win32") {
    const shell = Shell.acceptable()
    return [{ label: Shell.name(shell), shell }]
  }

  const list = [bash, Bun.which("pwsh"), Bun.which("powershell"), process.env.COMSPEC || Bun.which("cmd.exe")]
    .filter((shell): shell is string => Boolean(shell))
    .map((shell) => ({ label: Shell.name(shell), shell }))

  return list.filter(
    (item, i) => list.findIndex((other) => other.shell.toLowerCase() === item.shell.toLowerCase()) === i,
  )
})()
const PS = new Set(["pwsh", "powershell"])
const ps = shells.filter((item) => PS.has(item.label))
const cmdShell = shells.find((item) => item.label === "cmd")

const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

const js = (code: string) => {
  const text = `${bin} -e ${evalarg(code)}`
  if (PS.has(sh())) return `& ${text}`
  return text
}

const fill = (mode: "lines" | "bytes", n: number) => {
  const code =
    mode === "lines"
      ? "console.log(Array.from({length:Number(Bun.argv[1])},(_,i)=>i+1).join(String.fromCharCode(10)))"
      : "process.stdout.write(String.fromCharCode(97).repeat(Number(Bun.argv[1])))"
  const text = `${bin} -e ${evalarg(code)} ${n}`
  if (PS.has(sh())) return `& ${text}`
  return text
}
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

const forms = (dir: string) => {
  if (process.platform !== "win32") return [dir]
  const full = Filesystem.normalizePath(dir)
  const slash = full.replaceAll("\\", "/")
  const root = slash.replace(/^[A-Za-z]:/, "")
  return Array.from(new Set([full, slash, root, root.toLowerCase()]))
}

const withShell = (item: { label: string; shell: string }, fn: () => Promise<void>) => async () => {
  const prev = process.env.SHELL
  process.env.SHELL = item.shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

const each = (name: string, fn: (item: { label: string; shell: string }) => Promise<void>) => {
  for (const item of shells) {
    test(
      `${name} [${item.label}]`,
      withShell(item, () => fn(item)),
    )
  }
}

const capture = (requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">>, stop?: Error) => ({
  ...ctx,
  ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
    Effect.sync(() => {
      requests.push(req)
      if (stop) throw stop
    }),
})

const mustTruncate = (result: {
  metadata: { truncated?: boolean; exit?: number | null } & Record<string, unknown>
  output: string
}) => {
  if (result.metadata.truncated) return
  throw new Error(
    [`shell: ${process.env.SHELL || ""}`, `exit: ${String(result.metadata.exit)}`, "output:", result.output].join("\n"),
  )
}

describe("tool.shell", () => {
  each("basic", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: "echo test",
              description: "Echo test message",
            },
            ctx,
          ),
        )
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
      },
    })
  })

  test("decodes GB18030 byte output", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: js("process.stdout.write(Buffer.from([0x70,0x61,0x74,0x68,0x3a,0x20,0xc2,0xb7,0xbe,0xb6]))"),
              description: "Print GB18030 text",
            },
            ctx,
          ),
        )
        expect(result.output).toContain("path: 路径")
        expect(String(result.metadata.output)).toContain("path: 路径")
      },
    })
  })

  test("decodes GB18030 filename list output", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: js(
                "process.stdout.write(Buffer.from([0x64,0x61,0x69,0x6c,0x79,0x2e,0x6a,0x73,0x6f,0x6e,0x20,0xd6,0xd0,0xce,0xc4,0xce,0xc4,0xbc,0xfe,0xc3,0xfb,0x20,0xb2,0xe2,0xca,0xd4,0x2e,0x6d,0x64]))",
              ),
              description: "Print GB18030 file names",
            },
            ctx,
          ),
        )
        expect(result.output).toContain("daily.json 中文文件名 测试.md")
        expect(String(result.metadata.output)).toContain("daily.json 中文文件名 测试.md")
      },
    })
  })

  test("falls back from terminal-only configured shell", async () => {
    await using tmp = await tmpdir({
      config: { shell: "fish" },
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const fallback = Shell.name(Shell.acceptable("fish"))
        expect(fallback).not.toBe("fish")
        expect(bash.description).toContain(fallback)

        const result = await Effect.runPromise(
          bash.execute(
            {
              command: "echo fallback",
              description: "Echo fallback text",
            },
            ctx,
          ),
        )
        expect(result.metadata.exit).toBe(0)
        expect(result.output).toContain("fallback")
      },
    })
  })
})

describe("tool.shell permissions", () => {
  each("asks for bash permission with correct pattern", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initShell()
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await Effect.runPromise(
          bash.execute(
            {
              command: "echo hello",
              description: "Echo hello",
            },
            capture(requests),
          ),
        )
        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("bash")
        expect(requests[0].patterns).toContain("echo hello")
      },
    })
  })

  each("asks for bash permission with multiple commands", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initShell()
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await Effect.runPromise(
          bash.execute(
            {
              command: "echo foo && echo bar",
              description: "Echo twice",
            },
            capture(requests),
          ),
        )
        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("bash")
        expect(requests[0].patterns).toContain("echo foo")
        expect(requests[0].patterns).toContain("echo bar")
      },
    })
  })

  for (const item of ps) {
    test(
      `parses PowerShell conditionals for permission prompts [${item.label}]`,
      withShell(item, async () => {
        await WithInstance.provide({
          directory: projectRoot,
          fn: async () => {
            const bash = await initShell()
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            await Effect.runPromise(
              bash.execute(
                {
                  command: "Write-Host foo; if ($?) { Write-Host bar }",
                  description: "Check PowerShell conditional",
                },
                capture(requests),
              ),
            )
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(bashReq).toBeDefined()
            expect(bashReq!.patterns).toContain("Write-Host foo")
            expect(bashReq!.patterns).toContain("Write-Host bar")
            expect(bashReq!.always).toContain("Write-Host *")
          },
        })
      }),
    )
  }

  for (const item of ps) {
    test(
      `uses PowerShell cmdlet prefixes for always-allow prompts [${item.label}]`,
      withShell(item, async () => {
        await using tmp = await tmpdir()
        await WithInstance.provide({
          directory: tmp.path,
          fn: async () => {
            const bash = await initShell()
            const err = new Error("stop after permission")
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            await expect(
              Effect.runPromise(
                bash.execute(
                  {
                    command: "Remove-Item -Recurse tmp",
                    description: "Remove a temp directory",
                  },
                  capture(requests, err),
                ),
              ),
            ).rejects.toThrow(err.message)
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(bashReq).toBeDefined()
            expect(bashReq!.always).toContain("Remove-Item *")
            expect(bashReq!.always).not.toContain("Remove-Item -Recurse *")
          },
        })
      }),
    )
  }

  each("asks for external_directory permission for wildcard external paths", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const err = new Error("stop after permission")
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        const file = process.platform === "win32" ? `${process.env.WINDIR!.replaceAll("\\", "/")}/*` : "/etc/*"
        const want = process.platform === "win32" ? glob(path.join(process.env.WINDIR!, "*")) : "/etc/*"
        await expect(
          Effect.runPromise(
            bash.execute(
              {
                command: `cat ${file}`,
                description: "Read wildcard path",
              },
              capture(requests, err),
            ),
          ),
        ).rejects.toThrow(err.message)
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(want)
      },
    })
  })

  if (process.platform === "win32") {
    if (bash) {
      test(
        "asks for nested bash command permissions [bash]",
        withShell({ label: "bash", shell: bash }, async () => {
          await using outerTmp = await tmpdir({
            init: async (dir) => {
              await Bun.write(path.join(dir, "outside.txt"), "x")
            },
          })
          await WithInstance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initShell()
              const file = path.join(outerTmp.path, "outside.txt").replaceAll("\\", "/")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await Effect.runPromise(
                bash.execute(
                  {
                    command: `echo $(cat "${file}")`,
                    description: "Read nested bash file",
                  },
                  capture(requests),
                ),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(outerTmp.path, "*")))
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain(`cat "${file}"`)
            },
          })
        }),
      )
    }
  }

  if (process.platform === "win32") {
    for (const item of ps) {
      test(
        `asks for external_directory permission for PowerShell paths after switches [${item.label}]`,
        withShell(item, async () => {
          await WithInstance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initShell()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: `Copy-Item -PassThru "${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini" ./out`,
                      description: "Copy Windows ini",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for nested PowerShell command permissions [${item.label}]`,
        withShell(item, async () => {
          await WithInstance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initShell()
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const file = `${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`
              await Effect.runPromise(
                bash.execute(
                  {
                    command: `Write-Output $(Get-Content ${file})`,
                    description: "Read nested PowerShell file",
                  },
                  capture(requests),
                ),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain(`Get-Content ${file}`)
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for drive-relative PowerShell paths [${item.label}]`,
        withShell(item, async () => {
          await using tmp = await tmpdir()
          await WithInstance.provide({
            directory: tmp.path,
            fn: async () => {
              const bash = await initShell()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: 'Get-Content "C:../outside.txt"',
                      description: "Read drive-relative file",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp.path), "*")))
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for $HOME PowerShell paths [${item.label}]`,
        withShell(item, async () => {
          await WithInstance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initShell()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: 'Get-Content "$HOME/.ssh/config"',
                      description: "Read home config",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(os.homedir(), ".ssh", "*")))
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for $PWD PowerShell paths [${item.label}]`,
        withShell(item, async () => {
          await using tmp = await tmpdir()
          await WithInstance.provide({
            directory: tmp.path,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: 'Get-Content "$PWD/../outside.txt"',
                      description: "Read pwd-relative file",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp.path), "*")))
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for $PSHOME PowerShell paths [${item.label}]`,
        withShell(item, async () => {
          await WithInstance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: 'Get-Content "$PSHOME/outside.txt"',
                      description: "Read pshome file",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(item.shell), "*")))
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for missing PowerShell env paths [${item.label}]`,
        withShell(item, async () => {
          const key = "OPENCODE_TEST_MISSING"
          const prev = process.env[key]
          delete process.env[key]
          try {
            await WithInstance.provide({
              directory: projectRoot,
              fn: async () => {
                const bash = await initShell()
                const err = new Error("stop after permission")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                const root = path.parse(process.env.WINDIR!).root.replace(/[\\/]+$/, "")
                await expect(
                  Effect.runPromise(
                    bash.execute(
                      {
                        command: `Get-Content -Path "${root}$env:${key}\\Windows\\win.ini"`,
                        description: "Read Windows ini with missing env",
                      },
                      capture(requests, err),
                    ),
                  ),
                ).rejects.toThrow(err.message)
                const extDirReq = requests.find((r) => r.permission === "external_directory")
                expect(extDirReq).toBeDefined()
                expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
              },
            })
          } finally {
            if (prev === undefined) delete process.env[key]
            else process.env[key] = prev
          }
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for PowerShell env paths [${item.label}]`,
        withShell(item, async () => {
          await WithInstance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await Effect.runPromise(
                bash.execute(
                  {
                    command: "Get-Content $env:WINDIR/win.ini",
                    description: "Read Windows ini from env",
                  },
                  capture(requests),
                ),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for PowerShell FileSystem paths [${item.label}]`,
        withShell(item, async () => {
          await WithInstance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: `Get-Content -Path FileSystem::${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`,
                      description: "Read Windows ini from FileSystem provider",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for braced PowerShell env paths [${item.label}]`,
        withShell(item, async () => {
          await WithInstance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: "Get-Content ${env:WINDIR}/win.ini",
                      description: "Read Windows ini from braced env",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `treats Set-Location like cd for permissions [${item.label}]`,
        withShell(item, async () => {
          await WithInstance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await Effect.runPromise(
                bash.execute(
                  {
                    command: "Set-Location C:/Windows",
                    description: "Change location",
                  },
                  capture(requests),
                ),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
              expect(bashReq).toBeUndefined()
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `does not add nested PowerShell expressions to permission prompts [${item.label}]`,
        withShell(item, async () => {
          await WithInstance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initShell()
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await Effect.runPromise(
                bash.execute(
                  {
                    command: "Write-Output ('a' * 3)",
                    description: "Write repeated text",
                  },
                  capture(requests),
                ),
              )
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).not.toContain("a * 3")
              expect(bashReq!.always).not.toContain("a *")
            },
          })
        }),
      )
    }
  }

  if (process.platform === "win32" && cmdShell) {
    test(
      "asks for external_directory permission for cmd file commands [cmd]",
      withShell(cmdShell, async () => {
        await WithInstance.provide({
          directory: projectRoot,
          fn: async () => {
            const bash = await initShell()
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            await Effect.runPromise(
              bash.execute(
                {
                  command: `TYPE "${path.join(process.env.WINDIR!, "win.ini")}"`,
                  description: "Read Windows ini with cmd",
                },
                capture(requests),
              ),
            )
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            expect(extDirReq).toBeDefined()
            expect(extDirReq!.patterns).toContain(Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")))
          },
        })
      }),
    )
  }

  each("asks for external_directory permission when cd to parent", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const err = new Error("stop after permission")
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await expect(
          Effect.runPromise(
            bash.execute(
              {
                command: "cd ../",
                description: "Change to parent directory",
              },
              capture(requests, err),
            ),
          ),
        ).rejects.toThrow(err.message)
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
      },
    })
  })

  each("asks for external_directory permission when workdir is outside project", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const err = new Error("stop after permission")
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await expect(
          Effect.runPromise(
            bash.execute(
              {
                command: "echo ok",
                workdir: os.tmpdir(),
                description: "Echo from temp dir",
              },
              capture(requests, err),
            ),
          ),
        ).rejects.toThrow(err.message)
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(glob(path.join(os.tmpdir(), "*")))
      },
    })
  })

  if (process.platform === "win32") {
    test("normalizes external_directory workdir variants on Windows", async () => {
      const err = new Error("stop after permission")
      await using outerTmp = await tmpdir()
      await using tmp = await tmpdir()
      await WithInstance.provide({
        directory: tmp.path,
        fn: async () => {
          const bash = await initBash()
          const want = Filesystem.normalizePathPattern(path.join(outerTmp.path, "*"))

          for (const dir of forms(outerTmp.path)) {
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            await expect(
              Effect.runPromise(
                bash.execute(
                  {
                    command: "echo ok",
                    workdir: dir,
                    description: "Echo from external dir",
                  },
                  capture(requests, err),
                ),
              ),
            ).rejects.toThrow(err.message)

            const extDirReq = requests.find((r) => r.permission === "external_directory")
            expect({ dir, patterns: extDirReq?.patterns, always: extDirReq?.always }).toEqual({
              dir,
              patterns: [want],
              always: [want],
            })
          }
        },
      })
    })

    if (bash) {
      test(
        "uses Git Bash /tmp semantics for external workdir",
        withShell({ label: "bash", shell: bash }, async () => {
          await WithInstance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: "echo ok",
                      workdir: "/tmp",
                      description: "Echo from Git Bash tmp",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            },
          })
        }),
      )

      test(
        "uses Git Bash /tmp semantics for external file paths",
        withShell({ label: "bash", shell: bash }, async () => {
          await WithInstance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: "cat /tmp/opencode-does-not-exist",
                      description: "Read Git Bash tmp file",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            },
          })
        }),
      )
    }
  }

  each("asks for external_directory permission when file arg is outside project", async () => {
    await using outerTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "outside.txt"), "x")
      },
    })
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const err = new Error("stop after permission")
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        const filepath = path.join(outerTmp.path, "outside.txt")
        await expect(
          Effect.runPromise(
            bash.execute(
              {
                command: `cat ${filepath}`,
                description: "Read external file",
              },
              capture(requests, err),
            ),
          ),
        ).rejects.toThrow(err.message)
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        const expected = glob(path.join(outerTmp.path, "*"))
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(expected)
        expect(extDirReq!.always).toContain(expected)
      },
    })
  })

  each("does not ask for external_directory permission when rm inside project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "tmpfile"), "x")
      },
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await Effect.runPromise(
          bash.execute(
            {
              command: `rm -rf ${path.join(tmp.path, "nested")}`,
              description: "Remove nested dir",
            },
            capture(requests),
          ),
        )
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeUndefined()
      },
    })
  })

  each("includes always patterns for auto-approval", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await Effect.runPromise(
          bash.execute(
            {
              command: "git log --oneline -5",
              description: "Git log",
            },
            capture(requests),
          ),
        )
        expect(requests.length).toBe(1)
        expect(requests[0].always.length).toBeGreaterThan(0)
        expect(requests[0].always.some((item) => item.endsWith("*"))).toBe(true)
      },
    })
  })

  each("does not ask for bash permission when command is cd only", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initShell()
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await Effect.runPromise(
          bash.execute(
            {
              command: "cd .",
              description: "Stay in current directory",
            },
            capture(requests),
          ),
        )
        const bashReq = requests.find((r) => r.permission === "bash")
        expect(bashReq).toBeUndefined()
      },
    })
  })

  each("matches redirects in permission pattern", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initShell()
        const err = new Error("stop after permission")
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await expect(
          Effect.runPromise(
            bash.execute(
              { command: "echo test > output.txt", description: "Redirect test output" },
              capture(requests, err),
            ),
          ),
        ).rejects.toThrow(err.message)
        const bashReq = requests.find((r) => r.permission === "bash")
        expect(bashReq).toBeDefined()
        expect(bashReq!.patterns).toContain("echo test > output.txt")
      },
    })
  })

  each("always pattern has space before wildcard to not include different commands", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await Effect.runPromise(bash.execute({ command: "ls -la", description: "List" }, capture(requests)))
        const bashReq = requests.find((r) => r.permission === "bash")
        expect(bashReq).toBeDefined()
        expect(bashReq!.always[0]).toBe("ls *")
      },
    })
  })
})

describe("tool.shell abort", () => {
  test("preserves output when aborted", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const controller = new AbortController()
        const collected: string[] = []
        const res = await Effect.runPromise(
          bash.execute(
            {
              command: `echo before && sleep 30`,
              description: "Long running command",
            },
            {
              ...ctx,
              abort: controller.signal,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output && output.includes("before") && !controller.signal.aborted) {
                    collected.push(output)
                    controller.abort()
                  }
                }),
            },
          ),
        )
        expect(res.output).toContain("before")
        expect(res.output).toContain("User aborted the command")
        expect(collected.length).toBeGreaterThan(0)
      },
    })
  }, 15_000)

  // 命令用 unix syntax；Windows 走 PowerShell 不识别 `&&`/`sleep`，PS 语法等效命令独立测
  test.skipIf(process.platform === "win32")("terminates command on timeout", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: `echo started && sleep 60`,
              description: "Timeout test",
              timeout: 500,
            },
            ctx,
          ),
        )
        expect(result.output).toContain("started")
        expect(result.metadata.background).toBe(true)
        expect(result.output).toContain("moved to background")
      },
    })
  }, 15_000)

  test.skipIf(process.platform === "win32")("captures stderr in output", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: `echo stdout_msg && echo stderr_msg >&2`,
              description: "Stderr test",
            },
            ctx,
          ),
        )
        expect(result.output).toContain("stdout_msg")
        expect(result.output).toContain("stderr_msg")
        expect(result.metadata.exit).toBe(0)
      },
    })
  })

  test("returns non-zero exit code", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: `exit 42`,
              description: "Non-zero exit",
            },
            ctx,
          ),
        )
        expect(result.metadata.exit).toBe(42)
      },
    })
  })

  test("run_in_background returns a background id immediately", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: process.platform === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10",
              description: "long sleep",
              run_in_background: true,
            },
            ctx,
          ),
        )
        expect(result.metadata.background).toBe(true)
        expect(String(result.metadata.backgroundId)).toMatch(/^bash_\d+$/)
        expect(result.output).toContain(String(result.metadata.backgroundId))
      },
    })
  })

  test("background process count limit rejects when MAX_PER_SESSION exceeded", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const longCmd = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30"
        for (let i = 0; i < MAX_PER_SESSION; i++) {
          await Effect.runPromise(
            bash.execute(
              { command: longCmd, description: `bg slot ${i}`, run_in_background: true },
              ctx,
            ),
          )
        }
        const rejected = await Effect.runPromise(
          bash.execute(
            { command: longCmd, description: "over limit", run_in_background: true },
            ctx,
          ),
        )
        expect(rejected.metadata.processStatus).toBe("rejected")
        expect(rejected.output).toContain("limit")
      },
    })
  })

  test.skipIf(process.platform === "win32")("foreground command exceeding timeout is moved to background, not killed", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        // 使用独立 sessionID 避免继承早先测试积累的后台进程计数
        const isolatedCtx = { ...ctx, sessionID: SessionID.make("ses_timeout_bg") }
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: "sleep 10",
              description: "slow cmd",
              timeout: 300,
            },
            isolatedCtx,
          ),
        )
        expect(result.metadata.background).toBe(true)
        expect(String(result.metadata.backgroundId)).toMatch(/^bash_\d+$/)
        expect(result.output).toContain("moved to background")

        const backgroundId = String(result.metadata.backgroundId)
        const snap = await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            return yield* bg.snapshot(backgroundId)
          }),
        )
        expect(snap.status).toBe("running")
      },
    })
  })

  // 同 terminates command on timeout：unix syntax 命令在 Windows PS 解析失败
  test.skipIf(process.platform === "win32")("streams metadata updates progressively", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initBash()
        const updates: string[] = []
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: `echo first && sleep 0.1 && echo second`,
              description: "Streaming test",
            },
            {
              ...ctx,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output) updates.push(output)
                }),
            },
          ),
        )
        expect(result.output).toContain("first")
        expect(result.output).toContain("second")
        expect(updates.length).toBeGreaterThan(1)
      },
    })
  })
})

describe("tool.shell truncation", () => {
  test("truncates output exceeding line limit", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const lineCount = Truncate.MAX_LINES + 500
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: fill("lines", lineCount),
              description: "Generate lines exceeding limit",
            },
            ctx,
          ),
        )
        mustTruncate(result)
        // #B1 截断走 Truncate.output:横幅为 "...N lines/bytes truncated..." + 标准 hint
        expect(result.output).toMatch(/\.\.\.\d+ (lines|bytes) truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      },
    })
  })

  test("truncates output exceeding byte limit", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: fill("bytes", byteCount),
              description: "Generate bytes exceeding limit",
            },
            ctx,
          ),
        )
        mustTruncate(result)
        // #B1 截断走 Truncate.output:横幅为 "...N lines/bytes truncated..." + 标准 hint
        expect(result.output).toMatch(/\.\.\.\d+ (lines|bytes) truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      },
    })
  })

  test("does not truncate small output", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: "echo hello",
              description: "Echo hello",
            },
            ctx,
          ),
        )
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
        expect(result.output).toContain("hello")
      },
    })
  })

  test("full output is saved to file when truncated", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const lineCount = Truncate.MAX_LINES + 100
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: fill("lines", lineCount),
              description: "Generate lines for file check",
            },
            ctx,
          ),
        )
        mustTruncate(result)

        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()

        const saved = await Filesystem.readText(filepath!)
        const lines = saved.trim().split(/\r?\n/)
        expect(lines.length).toBe(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      },
    })
  })
})

describe("tool.shell background hardening", () => {
  // #3b:前台 spawn 失败应报错而非返回空成功
  test.skipIf(process.platform === "win32")("foreground spawn failure throws instead of returning empty success", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        // 使用一个确定不存在的 cwd 让 spawn 失败
        const nonExistentDir = path.join(os.tmpdir(), `opencode-nonexistent-${Date.now()}`)
        await expect(
          Effect.runPromise(
            bash.execute(
              {
                command: "echo hi",
                workdir: nonExistentDir,
                description: "spawn failure test",
              },
              ctx,
            ),
          ),
        ).rejects.toThrow("Command failed to start")
      },
    })
  }, 10_000)

  // #6:后台进程达到上限后,超时命令应被 kill 而非转后台
  test.skipIf(process.platform === "win32")("timeout kill when background limit reached", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        // 使用独立 sessionID,避免影响其他测试的后台计数
        const bgCtx = { ...ctx, sessionID: SessionID.make("ses_bg_limit") }
        // 填满后台槽
        for (let i = 0; i < MAX_PER_SESSION; i++) {
          await Effect.runPromise(
            bash.execute(
              { command: "sleep 60", description: `bg slot ${i}`, run_in_background: true },
              bgCtx,
            ),
          )
        }
        // 触发超时,后台满了应被 kill 而非转后台
        const result = await Effect.runPromise(
          bash.execute(
            { command: "sleep 60", description: "over limit timeout", timeout: 300 },
            bgCtx,
          ),
        )
        expect(result.metadata.background).toBeUndefined()
        expect(result.output).toContain("limit")
      },
    })
  }, 15_000)

  // #4:显式后台命令 spawn 失败,bash-output 须读到真实失败文本,而非"无输出"
  test.skipIf(process.platform === "win32")("explicit background spawn failure is surfaced via bash-output", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const bashOutput = await runtime.runPromise(BashOutputTool.pipe(Effect.flatMap((i) => i.init())))
        const bgCtx = { ...ctx, sessionID: SessionID.make("ses_bg_spawn_fail") }
        // 不存在的 cwd 让 spawn 在 drain fiber 内失败;显式后台立即返回 id
        const nonExistentDir = path.join(os.tmpdir(), `opencode-nonexistent-bg-${Date.now()}`)
        const started = await Effect.runPromise(
          bash.execute(
            { command: "echo hi", workdir: nonExistentDir, description: "bg spawn fail", run_in_background: true },
            bgCtx,
          ),
        )
        const id = String(started.metadata.backgroundId)
        // 给 drain fiber 时间结算失败
        await new Promise((r) => setTimeout(r, 400))
        const out = await Effect.runPromise(bashOutput.execute({ id }, bgCtx))
        // 失败被透出,而非"no new output"
        expect(out.output).toContain("command failed")
      },
    })
  }, 10_000)

  // #2/#3:session 级 deny bash-output 时,后台监控不可用
  test.skipIf(process.platform === "win32")("session deny of bash-output blocks background paths", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        // 创建一个 session,其权限显式 deny bash-output
        const session = await runtime.runPromise(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({
              permission: [{ permission: "bash-output", pattern: "*", action: "deny" }],
            })
          }),
        )
        const denyCtx = { ...ctx, sessionID: session.id }

        // 显式后台:无监控能力 → 直接拒绝,不转后台
        const bgResult = await Effect.runPromise(
          bash.execute(
            { command: "sleep 10", description: "denied bg", run_in_background: true },
            denyCtx,
          ),
        )
        expect(bgResult.metadata.background).toBeUndefined()
        expect(bgResult.metadata.processStatus).toBe("rejected")
        expect(bgResult.output).toContain("Cannot run in background")

        // 前台超时:无监控能力 → kill 而非转后台
        const toResult = await Effect.runPromise(
          bash.execute(
            { command: "sleep 10", description: "denied timeout", timeout: 300 },
            denyCtx,
          ),
        )
        expect(toResult.metadata.background).toBeUndefined()
        expect(toResult.output).toContain("cannot monitor")
      },
    })
  }, 15_000)

  // #A2:超时转后台(仍在运行)即便已溢出建文件,也绝不打 "Full output saved to file"
  // (sink 还在写,文件不完整);只给裁剪后的内存尾部预览 + 后台提示;previewOnly → 无 outputPath、truncated=false
  test.skipIf(process.platform === "win32")("timeout-detached output omits saved-to-file hint and keeps background hint", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const detachCtx = { ...ctx, sessionID: SessionID.make("ses_detach_nofile") }
        const byteCount = Truncate.MAX_BYTES + 20000 // 先溢出建文件
        const result = await Effect.runPromise(
          bash.execute(
            { command: `${fill("bytes", byteCount)}; sleep 10`, description: "overflow then keep running", timeout: 400 },
            detachCtx,
          ),
        )
        // 转后台:带后台提示
        expect(result.metadata.background).toBe(true)
        expect(result.output).toContain("moved to background")
        // #A2 关键:进程仍在运行,完整输出还在落盘 → 绝不打 "saved to file" 措辞
        expect(result.output).not.toContain("Full output saved to")
        expect(result.output).not.toContain("The tool call succeeded")
        // previewOnly:metadata 不指向文件,truncated 为 false
        expect((result.metadata as { outputPath?: string }).outputPath).toBeUndefined()
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
        // 清理后台进程
        const id = String(result.metadata.backgroundId)
        await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            yield* bg.kill(id, detachCtx.sessionID)
          }),
        )
      },
    })
  }, 15_000)

  // #7/#8:大输出溢出文件且在超时内退出,exit Deferred 不被慢 flush 阻塞:
  // 不应误判为转后台,且 awaitFlush 后文件内容完整
  test.skipIf(process.platform === "win32")("large overflow output exits within timeout: complete file, not backgrounded", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initShell()
        const byteCount = Truncate.MAX_BYTES + 50000
        const result = await Effect.runPromise(
          bash.execute(
            { command: fill("bytes", byteCount), description: "big output exits in time", timeout: 8000 },
            { ...ctx, sessionID: SessionID.make("ses_overflow_flush") },
          ),
        )
        // 命令在超时内退出 → 走 exit 路径,绝不转后台
        expect(result.metadata.background).toBeUndefined()
        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()
        // awaitFlush 生效:sink 已 flush 完整,文件字节数等于全部输出
        const saved = await Filesystem.readText(filepath!)
        expect(Buffer.byteLength(saved, "utf-8")).toBe(byteCount)
      },
    })
  }, 15_000)
})
