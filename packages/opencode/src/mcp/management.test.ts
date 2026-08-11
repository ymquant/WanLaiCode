import { describe, expect, test } from "bun:test"
import { Addon } from "@/addon"
import { Config } from "@/config/config"
import { ConfigMCP } from "@/config/mcp"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { MCP } from "."
import { McpManagement } from "./management"

const localForm: McpManagement.LocalForm = {
  type: "local",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-everything"],
  environment: [{ key: "MODE", value: "read-only" }],
  inherited_environment: ["GITHUB_TOKEN"],
  cwd: "~/code",
  timeout: 10_000,
}

const remoteForm: McpManagement.RemoteForm = {
  type: "remote",
  url: "https://mcp.example.com/mcp",
  headers: [{ key: "X-Tenant", value: "wanlai" }],
  environment_headers: [{ key: "X-Account", env: "MCP_ACCOUNT" }],
  bearer_token_env: "MCP_TOKEN",
  oauth: {
    enabled: true,
    client_id: "desktop",
    client_secret_env: "MCP_CLIENT_SECRET",
    scope: "tools:read",
    redirect_uri: "http://127.0.0.1:19876/mcp/oauth/callback",
  },
}

describe("McpManagement conversions", () => {
  test("splits a local command and redacts inherited environment values", () => {
    expect(
      McpManagement.toForm({
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-everything"],
        environment: {
          MODE: "read-only",
          GITHUB_TOKEN: "{env:GITHUB_TOKEN}",
        },
        cwd: "~/code",
        timeout: 10_000,
      }),
    ).toEqual(localForm)
  })

  test("separates remote environment references from literal fields", () => {
    expect(
      McpManagement.toForm({
        type: "remote",
        url: "https://mcp.example.com/mcp",
        headers: {
          Authorization: "Bearer {env:MCP_TOKEN}",
          "X-Tenant": "wanlai",
          "X-Account": "{env:MCP_ACCOUNT}",
        },
        oauth: {
          clientId: "desktop",
          clientSecret: "{env:MCP_CLIENT_SECRET}",
          scope: "tools:read",
          redirectUri: "http://127.0.0.1:19876/mcp/oauth/callback",
        },
      }),
    ).toEqual(remoteForm)
  })

  test("reports configured legacy secrets without returning their plaintext", () => {
    const form = McpManagement.toForm({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer literal-secret" },
      oauth: { clientSecret: "literal-client-secret" },
    })

    expect(form).toMatchObject({
      bearer_token_configured: true,
      oauth: { client_secret_configured: true },
    })
    expect(JSON.stringify(form)).not.toContain("literal-secret")
    expect(JSON.stringify(form)).not.toContain("literal-client-secret")
  })

  test("reconstructs local and remote raw config from forms", () => {
    expect(McpManagement.fromForm(localForm)).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-everything"],
      environment: {
        MODE: "read-only",
        GITHUB_TOKEN: "{env:GITHUB_TOKEN}",
      },
      cwd: "~/code",
      timeout: 10_000,
    })
    expect(McpManagement.fromForm(remoteForm)).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: {
        Authorization: "Bearer {env:MCP_TOKEN}",
        "X-Tenant": "wanlai",
        "X-Account": "{env:MCP_ACCOUNT}",
      },
      oauth: {
        clientId: "desktop",
        clientSecret: "{env:MCP_CLIENT_SECRET}",
        scope: "tools:read",
        redirectUri: "http://127.0.0.1:19876/mcp/oauth/callback",
      },
    })
  })

  test("only preserves configured legacy secrets when the previous config contains them", () => {
    const requested: McpManagement.RemoteForm = {
      ...remoteForm,
      bearer_token_env: undefined,
      bearer_token_configured: true,
      oauth: {
        enabled: true,
        client_secret_env: undefined,
        client_secret_configured: true,
      },
    }
    expect(
      McpManagement.fromForm(requested, {
        type: "remote",
        url: "https://old.example.com/mcp",
        headers: { Authorization: "Bearer literal-token" },
        oauth: { clientSecret: "literal-client-secret" },
      }),
    ).toMatchObject({
      headers: { Authorization: "Bearer literal-token" },
      oauth: { clientSecret: "literal-client-secret" },
    })
    expect(McpManagement.fromForm(requested)).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: {
        "X-Tenant": "wanlai",
        "X-Account": "{env:MCP_ACCOUNT}",
      },
    })
  })

  test("represents default, disabled, and configured OAuth without writing an empty object", () => {
    expect(
      McpManagement.toForm({
        type: "remote",
        url: "https://mcp.example.com/default",
      }),
    ).not.toHaveProperty("oauth")
    expect(
      McpManagement.toForm({
        type: "remote",
        url: "https://mcp.example.com/disabled",
        oauth: false,
      }),
    ).toMatchObject({ oauth: false })

    expect(
      McpManagement.fromForm({
        type: "remote",
        url: "https://mcp.example.com/default",
        headers: [],
        environment_headers: [],
      }),
    ).not.toHaveProperty("oauth")
    expect(
      McpManagement.fromForm({
        type: "remote",
        url: "https://mcp.example.com/enabled",
        headers: [],
        environment_headers: [],
        oauth: { enabled: true },
      }),
    ).not.toHaveProperty("oauth")
    expect(
      McpManagement.fromForm({
        type: "remote",
        url: "https://mcp.example.com/disabled",
        headers: [],
        environment_headers: [],
        oauth: false,
      }),
    ).toMatchObject({ oauth: false })
  })

  test("trims dynamic rows and drops fully empty local and remote values", () => {
    expect(
      McpManagement.fromForm({
        type: "local",
        command: "  npx  ",
        args: ["  -y  ", "   "],
        environment: [
          { key: " MODE ", value: " read-only " },
          { key: " ", value: " " },
        ],
        inherited_environment: [" TOKEN ", "  "],
      }),
    ).toEqual({
      type: "local",
      command: ["npx", "-y"],
      environment: {
        MODE: "read-only",
        TOKEN: "{env:TOKEN}",
      },
    })
    expect(
      McpManagement.fromForm({
        type: "remote",
        url: " https://mcp.example.com/mcp ",
        bearer_token_env: " TOKEN ",
        headers: [
          { key: " X-Tenant ", value: " wanlai " },
          { key: " ", value: " " },
        ],
        environment_headers: [
          { key: " X-Account ", env: " ACCOUNT " },
          { key: " ", env: " " },
        ],
        oauth: {
          enabled: true,
          client_id: " desktop ",
          client_secret_env: " CLIENT_SECRET ",
          scope: " tools:read ",
          redirect_uri: " https://app.example.com/callback ",
        },
      }),
    ).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: {
        "X-Tenant": "wanlai",
        "X-Account": "{env:ACCOUNT}",
        Authorization: "Bearer {env:TOKEN}",
      },
      oauth: {
        clientId: "desktop",
        clientSecret: "{env:CLIENT_SECRET}",
        scope: "tools:read",
        redirectUri: "https://app.example.com/callback",
      },
    })
  })

  test("never serializes half-filled dynamic rows or empty keys", () => {
    expect(
      McpManagement.fromForm({
        type: "local",
        command: "echo",
        args: [],
        environment: [
          { key: "", value: "secret-canary" },
          { key: "EMPTY_VALUE", value: "" },
        ],
        inherited_environment: [],
      }),
    ).toEqual({
      type: "local",
      command: ["echo"],
      environment: {},
    })
    expect(
      McpManagement.fromForm({
        type: "remote",
        url: "https://mcp.example.com/mcp",
        headers: [{ key: "", value: "secret-canary" }],
        environment_headers: [{ key: "X-Token", env: "" }],
      }),
    ).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: {},
    })
  })
})

describe("McpManagement validation", () => {
  test("accepts only enabled true for configured OAuth objects", () => {
    const decode = Schema.decodeUnknownSync(McpManagement.OAuthForm)
    expect(decode({ enabled: true })).toEqual({ enabled: true })
    expect(() => decode({ enabled: false })).toThrow()
  })

  test("rejects missing and malformed names", () => {
    expect(McpManagement.validateName("")).toBe("name_required")
    expect(McpManagement.validateName("bad name")).toBe("name_invalid")
    expect(McpManagement.validateName("valid-name_1.with.dot")).toBeUndefined()
    expect(McpManagement.validateName(`a${"b".repeat(63)}`)).toBeUndefined()
    expect(McpManagement.validateName(`a${"b".repeat(64)}`)).toBe("name_invalid")
    expect(McpManagement.validateName(".leading-dot")).toBe("name_invalid")
    expect(McpManagement.validateName("  trimmed.name  ")).toBeUndefined()
  })

  test("rejects non-HTTP remote URLs and malformed environment names", () => {
    expect(McpManagement.validateForm({ ...remoteForm, url: "file:///tmp/mcp" })).toBe("url_invalid")
    expect(McpManagement.validateForm({ ...remoteForm, bearer_token_env: "bad-name" })).toBe("env_invalid")
  })

  test("rejects malformed local environment keys", () => {
    expect(
      McpManagement.validateForm({
        ...localForm,
        environment: [{ key: "bad-name", value: "read-only" }],
      }),
    ).toBe("env_invalid")
  })

  test("rejects competing Authorization inputs", () => {
    expect(
      McpManagement.validateForm({
        ...remoteForm,
        bearer_token_env: "TOKEN",
        headers: [{ key: "Authorization", value: "Basic value" }],
      }),
    ).toBe("authorization_conflict")
  })

  test("rejects Authorization in ordinary header fields without a bearer setting", () => {
    expect(
      McpManagement.validateForm({
        ...remoteForm,
        bearer_token_env: undefined,
        headers: [{ key: " authorization ", value: "Bearer ordinary-value" }],
      }),
    ).toBe("authorization_conflict")
    expect(
      McpManagement.validateForm({
        ...remoteForm,
        bearer_token_env: undefined,
        environment_headers: [{ key: "AUTHORIZATION", env: "MCP_ACCOUNT" }],
      }),
    ).toBe("authorization_conflict")
  })

  test("does not convert ordinary Authorization fields into raw config", () => {
    const config = McpManagement.fromForm({
      ...remoteForm,
      bearer_token_env: undefined,
      headers: [{ key: " Authorization ", value: "Bearer ordinary-value" }],
      environment_headers: [{ key: " authorization ", env: "MCP_ACCOUNT" }],
    })
    expect(config).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: {},
      oauth: {
        clientId: "desktop",
        clientSecret: "{env:MCP_CLIENT_SECRET}",
        scope: "tools:read",
        redirectUri: "http://127.0.0.1:19876/mcp/oauth/callback",
      },
    })
    expect(JSON.stringify(config)).not.toContain("ordinary-value")
  })

  test("rejects duplicate keys and partially filled rows", () => {
    expect(
      McpManagement.validateForm({
        ...localForm,
        environment: [
          { key: "MODE", value: "read-only" },
          { key: "MODE", value: "write" },
        ],
      }),
    ).toBe("key_duplicate")
    expect(
      McpManagement.validateForm({
        ...remoteForm,
        headers: [{ key: "X-Tenant", value: "" }],
      }),
    ).toBe("row_incomplete")
    expect(
      McpManagement.validateForm({
        ...remoteForm,
        headers: [{ key: " ", value: "secret" }],
      }),
    ).toBe("row_incomplete")
    expect(
      McpManagement.validateForm({
        ...remoteForm,
        headers: [{ key: " ", value: " " }],
        environment_headers: [],
      }),
    ).toBeUndefined()
  })

  test("rejects invalid timeouts and OAuth redirect URIs", () => {
    expect(McpManagement.validateForm({ ...localForm, timeout: 0 })).toBe("timeout_invalid")
    expect(
      McpManagement.validateForm({
        ...remoteForm,
        oauth: { enabled: true, redirect_uri: "file:///tmp/callback" },
      }),
    ).toBe("redirect_uri_invalid")
  })
})

function managementFixture(options?: {
  failUpdate?: boolean
  dieUpdate?: string
  interruptUpdate?: boolean
  customEnabled?: boolean
  addonMcpEnabled?: boolean
  statuses?: Record<string, MCP.Status>
  raw?: NonNullable<Config.Info["mcp"]>
  addonConfig?: ConfigMCP.Info
  addonDeclaration?: {
    enabled?: boolean
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    url?: string
    http_headers?: Record<string, string>
    env_http_headers?: Record<string, string>
    bearer_token_env_var?: string
  }
  pauseFirstStatus?: {
    reached: () => void
    wait: Promise<void>
  }
  addonToggleFailure?: "error" | "defect" | "interrupt"
}) {
  let raw: NonNullable<Config.Info["mcp"]> = options?.raw ?? {
    custom: {
      type: "local",
      command: ["npx", "custom"],
      enabled: options?.customEnabled,
    },
  }
  const updatePatches: Config.Info[] = []
  const addonToggles: Array<{ addonKey: string; name: string; enabled: boolean }> = []
  const addonToggleOptions: Array<{ removeGlobalMcp?: boolean } | undefined> = []
  const reconciles: string[][] = []
  const addons = [
    {
      root: "/tmp/demo",
      manifest: { name: "demo" },
      addonId: { addonName: "demo", marketplaceName: "personal" },
      mcpServers: {
        "plugin-mcp": options?.addonConfig ?? {
          type: "remote" as const,
          url: "https://plugin.example.com/mcp",
          headers: { Authorization: "Bearer plugin-secret" },
          enabled: options?.addonMcpEnabled,
        },
      },
      mcpServerDeclarations: {
        "plugin-mcp": options?.addonDeclaration ?? {
          url: "https://plugin.example.com/mcp",
          http_headers: { Authorization: "Bearer plugin-secret" },
        },
      },
    },
  ]
  const applyPatch = (patch: Config.Info) => {
    updatePatches.push(patch)
    const entries = Object.entries(
      (patch as unknown as { mcp?: Record<string, ConfigMCP.Info | undefined> }).mcp ?? {},
    )
    raw = entries.reduce<NonNullable<Config.Info["mcp"]>>(
      (result, [name, value]) => {
        if (value === undefined) {
          delete result[name]
          return result
        }
        result[name] = value
        return result
      },
      { ...raw },
    )
  }
  const updateGlobalMcp = (<A>(mutate: Parameters<Config.Interface["updateGlobalMcp"]>[0]) =>
    Effect.suspend(() => {
      if (options?.failUpdate) return Effect.fail(new Error("write failed"))
      if (options?.dieUpdate) return Effect.die(new Error(options.dieUpdate))
      if (options?.interruptUpdate) return Effect.interrupt
      const mutation = mutate(raw)
      if (mutation.patch) applyPatch({ mcp: mutation.patch } as unknown as Config.Info)
      return Effect.succeed({ result: mutation.result, changed: Boolean(mutation.patch) })
    })) as Config.Interface["updateGlobalMcp"]
  const config = Config.Service.of({
    getGlobalMcpRaw: () => Effect.succeed(raw),
    updateGlobal: (patch: Config.Info) => {
      if (options?.failUpdate) return Effect.fail(new Error("write failed"))
      if (options?.dieUpdate) return Effect.die(new Error(options.dieUpdate))
      if (options?.interruptUpdate) return Effect.interrupt
      applyPatch(patch)
      return Effect.succeed({ info: { mcp: raw }, changed: true })
    },
    updateGlobalMcp,
  } as unknown as Config.Interface)
  let addonToggleFailed = false
  const addon = Addon.Service.of({
    getAddons: () => Effect.succeed(addons),
    setMcpEnabled: (
      addonKey: string,
      name: string,
      enabled: boolean,
      toggleOptions?: { removeGlobalMcp?: boolean },
    ) => {
      addonToggles.push({ addonKey, name, enabled })
      addonToggleOptions.push(toggleOptions)
      if (options?.addonToggleFailure && !addonToggleFailed) {
        addonToggleFailed = true
        if (options.addonToggleFailure === "error") return Effect.fail(new Error("addon write failed"))
        if (options.addonToggleFailure === "defect") return Effect.die(new Error("addon write defect"))
        return Effect.interrupt
      }
      if (toggleOptions?.removeGlobalMcp) {
        raw = { ...raw }
        delete raw[name]
      }
      return Effect.void
    },
  } as unknown as Addon.Interface)
  let statusCalls = 0
  const mcp = MCP.Service.of({
    status: () => {
      statusCalls += 1
      const result =
        options?.statuses ?? {
          custom: { status: "connected" as const },
          "plugin-mcp": { status: "needs_auth" as const },
          renamed: { status: "connected" as const },
        }
      if (!options?.pauseFirstStatus || statusCalls !== 1) return Effect.succeed(result)
      options.pauseFirstStatus.reached()
      return Effect.promise(() => options.pauseFirstStatus!.wait).pipe(Effect.as(result))
    },
    reconcile: (restart = []) => {
      reconciles.push(restart)
      return Effect.void
    },
  } as unknown as MCP.Interface)
  return {
    layer: McpManagement.layer.pipe(
      Layer.provide(Layer.mergeAll(Layer.succeed(Config.Service, config), Layer.succeed(Addon.Service, addon))),
      Layer.provide(Layer.succeed(MCP.Service, mcp)),
    ),
    updatePatches,
    addonToggles,
    addonToggleOptions,
    reconciles: () => reconciles,
    raw: () => raw,
  }
}

describe("McpManagement service", () => {
  test("lists custom and enabled addon MCPs with ownership and redacted detail", async () => {
    const fixture = managementFixture()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpManagement.Service
        return {
          items: yield* service.list(),
          detail: yield* service.get("plugin-mcp"),
        }
      }).pipe(Effect.provide(fixture.layer)),
    )

    expect(result.items).toEqual([
      expect.objectContaining({
        name: "custom",
        source: "custom",
        editable: true,
        status: { status: "connected" },
      }),
      expect.objectContaining({
        name: "plugin-mcp",
        source: "addon",
        editable: false,
        addon_key: "demo@personal",
        status: { status: "needs_auth" },
      }),
    ])
    expect(result.detail).toMatchObject({
      name: "plugin-mcp",
      status: { status: "needs_auth" },
      config: { type: "remote", bearer_token_configured: true },
    })
    expect(JSON.stringify(result.detail)).not.toContain("plugin-secret")
  })

  test("builds addon details from unresolved declaration provenance", async () => {
    const fixture = managementFixture({
      addonConfig: {
        type: "remote",
        url: "https://plugin.example.com/mcp",
        headers: {
          Authorization: "Bearer resolved-token-canary",
          "X-Env": "resolved-header-canary",
        },
      },
      addonDeclaration: {
        url: "https://plugin.example.com/mcp",
        bearer_token_env_var: "ADDON_TOKEN_ENV",
        env_http_headers: { "X-Env": "ADDON_HEADER_ENV" },
      },
    })
    const detail = await Effect.runPromise(
      McpManagement.Service.use((service) => service.get("plugin-mcp")).pipe(Effect.provide(fixture.layer)),
    )

    expect(detail.config).toMatchObject({
      type: "remote",
      bearer_token_env: "ADDON_TOKEN_ENV",
      environment_headers: [{ key: "X-Env", env: "ADDON_HEADER_ENV" }],
    })
    expect(JSON.stringify(detail)).not.toContain("resolved-token-canary")
    expect(JSON.stringify(detail)).not.toContain("resolved-header-canary")
  })

  test("marks custom environment aliases read-only while retaining toggle", async () => {
    const fixture = managementFixture({
      raw: {
        alias: {
          type: "local",
          command: ["echo"],
          environment: { DEST_TOKEN: "{env:SOURCE_TOKEN}" },
        },
      },
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpManagement.Service
        const list = yield* service.list()
        const detail = yield* service.get("alias")
        yield* service.toggle("alias", false)
        return { list, detail }
      }).pipe(Effect.provide(fixture.layer)),
    )

    expect(result.list[0]).toMatchObject({ name: "alias", editable: false })
    expect(result.detail).toMatchObject({ name: "alias", editable: false })
    expect(fixture.updatePatches[0]).toMatchObject({
      mcp: {
        alias: {
          environment: { DEST_TOKEN: "{env:SOURCE_TOKEN}" },
          enabled: false,
        },
      },
    })
  })

  test("keeps a legacy disabled override manageable as its addon server", async () => {
    const fixture = managementFixture({
      raw: {
        "plugin-mcp": { enabled: false },
      },
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpManagement.Service
        const list = yield* service.list()
        const detail = yield* service.get("plugin-mcp")
        yield* service.toggle("plugin-mcp", true)
        return { list, detail }
      }).pipe(Effect.provide(fixture.layer)),
    )

    expect(result.list).toEqual([
      expect.objectContaining({ name: "plugin-mcp", source: "addon", enabled: false, editable: false }),
    ])
    expect(result.detail).toMatchObject({ name: "plugin-mcp", source: "addon", enabled: false })
    expect(fixture.raw()).not.toHaveProperty("plugin-mcp")
    expect(fixture.addonToggles).toEqual([{ addonKey: "demo@personal", name: "plugin-mcp", enabled: true }])
    expect(fixture.addonToggleOptions).toEqual([{ removeGlobalMcp: true }])
    expect(fixture.reconciles()).toEqual([[]])
  })

  for (const failure of ["error", "defect", "interrupt"] as const) {
    test(`legacy addon enable remains disabled and retryable after ${failure}`, async () => {
      const fixture = managementFixture({
        raw: { "plugin-mcp": { enabled: false } },
        addonToggleFailure: failure,
      })
      const first = await Effect.runPromiseExit(
        McpManagement.Service.use((service) => service.toggle("plugin-mcp", true)).pipe(
          Effect.provide(fixture.layer),
        ),
      )

      expect(Exit.isFailure(first)).toBe(true)
      if (failure === "interrupt") {
        expect(Exit.isFailure(first) && Cause.hasInterrupts(first.cause)).toBe(true)
      } else {
        const error = Exit.isFailure(first) ? Cause.squash(first.cause) : undefined
        expect(error).toBeInstanceOf(McpManagement.ManagementError)
        expect((error as McpManagement.ManagementError).code).toBe("write_failed")
      }
      expect(fixture.raw()["plugin-mcp"]).toEqual({ enabled: false })
      expect(fixture.reconciles()).toEqual([])

      await Effect.runPromise(
        McpManagement.Service.use((service) => service.toggle("plugin-mcp", true)).pipe(
          Effect.provide(fixture.layer),
        ),
      )
      expect(fixture.raw()).not.toHaveProperty("plugin-mcp")
      expect(fixture.reconciles()).toEqual([[]])
    })
  }

  test("reports disabled for custom and addon configs despite stale failed runtime status", async () => {
    const fixture = managementFixture({
      customEnabled: false,
      addonMcpEnabled: false,
      statuses: {
        custom: { status: "failed", error: "stale custom failure" },
        "plugin-mcp": { status: "failed", error: "stale addon failure" },
      },
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpManagement.Service
        return {
          items: yield* service.list(),
          custom: yield* service.get("custom"),
          addon: yield* service.get("plugin-mcp"),
        }
      }).pipe(Effect.provide(fixture.layer)),
    )

    expect(result.items.map((entry) => [entry.name, entry.status])).toEqual([
      ["custom", { status: "disabled" }],
      ["plugin-mcp", { status: "disabled" }],
    ])
    expect(result.custom.status).toEqual({ status: "disabled" })
    expect(result.addon.status).toEqual({ status: "disabled" })
  })

  test("renames a custom MCP in one patch and reconciles once", async () => {
    const fixture = managementFixture()
    const detail = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpManagement.Service
        return yield* service.save({ name: "renamed", original_name: "custom", config: localForm })
      }).pipe(Effect.provide(fixture.layer)),
    )

    expect(detail.name).toBe("renamed")
    expect(fixture.updatePatches).toHaveLength(1)
    expect(fixture.updatePatches[0]).toMatchObject({
      mcp: {
        custom: undefined,
        renamed: expect.objectContaining({ type: "local" }),
      },
    })
    expect(fixture.reconciles()).toEqual([["custom", "renamed"]])
  })

  test("force-restarts a same-name custom MCP after saving changed transport config", async () => {
    const fixture = managementFixture()
    await Effect.runPromise(
      McpManagement.Service.use((service) =>
        service.save({
          name: "custom",
          original_name: "custom",
          config: { ...localForm, command: "changed-command" },
        }),
      ).pipe(Effect.provide(fixture.layer)),
    )

    expect(fixture.reconciles()).toEqual([["custom"]])
  })

  test("custom toggle preserves a concurrent save by rereading inside the MCP update lock", async () => {
    let releaseStatus!: () => void
    const wait = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })
    let markStatusReached!: () => void
    const statusReached = new Promise<void>((resolve) => {
      markStatusReached = resolve
    })
    const fixture = managementFixture({
      pauseFirstStatus: {
        reached: markStatusReached,
        wait,
      },
    })
    const toggle = Effect.runPromise(
      McpManagement.Service.use((service) => service.toggle("custom", false)).pipe(Effect.provide(fixture.layer)),
    )
    await statusReached

    await Effect.runPromise(
      McpManagement.Service.use((service) =>
        service.save({
          name: "custom",
          original_name: "custom",
          config: { ...localForm, command: "saved-command" },
        }),
      ).pipe(Effect.provide(fixture.layer)),
    )
    releaseStatus()
    await toggle

    expect(fixture.raw().custom).toMatchObject({ type: "local", enabled: false })
    expect((fixture.raw().custom as ConfigMCP.Local).command[0]).toBe("saved-command")
  })

  test("trims a new server name at the save boundary", async () => {
    const fixture = managementFixture()
    const detail = await Effect.runPromise(
      McpManagement.Service.use((service) => service.save({ name: "  trimmed.name  ", config: localForm })).pipe(
        Effect.provide(fixture.layer),
      ),
    )

    expect(detail.name).toBe("trimmed.name")
    expect(fixture.updatePatches[0]).toHaveProperty(["mcp", "trimmed.name"])
    expect(fixture.updatePatches[0]).not.toHaveProperty(["mcp", "  trimmed.name  "])
  })

  test("serializes concurrent creates so exactly one duplicate name is rejected", async () => {
    const fixture = managementFixture({ raw: {} })
    const [first, second] = await Promise.all(
      ["echo-one", "echo-two"].map((command) =>
        Effect.runPromiseExit(
          McpManagement.Service.use((service) =>
            service.save({
              name: "shared",
              config: { ...localForm, command },
            }),
          ).pipe(Effect.provide(fixture.layer)),
        ),
      ),
    )

    expect([first, second].filter(Exit.isSuccess)).toHaveLength(1)
    const failure = [first, second].find(Exit.isFailure)
    const error = failure && Cause.squash(failure.cause)
    expect(error).toBeInstanceOf(McpManagement.ManagementError)
    expect((error as McpManagement.ManagementError).code).toBe("conflict")
    expect(fixture.updatePatches).toHaveLength(1)
  })

  test("rejects addon removal and conflicts with addon names", async () => {
    const fixture = managementFixture()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpManagement.Service
        return {
          remove: yield* Effect.flip(service.remove("plugin-mcp")),
          conflict: yield* Effect.flip(service.save({ name: "plugin-mcp", config: localForm })),
        }
      }).pipe(Effect.provide(fixture.layer)),
    )

    expect(result.remove.code).toBe("read_only")
    expect(result.conflict.code).toBe("conflict")
    expect(fixture.reconciles()).toEqual([])
  })

  test("toggles an addon MCP through its owner and reconciles once", async () => {
    const fixture = managementFixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpManagement.Service
        yield* service.toggle("plugin-mcp", false)
      }).pipe(Effect.provide(fixture.layer)),
    )

    expect(fixture.addonToggles).toEqual([{ addonKey: "demo@personal", name: "plugin-mcp", enabled: false }])
    expect(fixture.reconciles()).toEqual([[]])
  })

  test("propagates a failed write without reconciling or changing readable detail", async () => {
    const fixture = managementFixture({ failUpdate: true })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpManagement.Service
        return {
          save: yield* Effect.flip(service.save({ name: "renamed", original_name: "custom", config: localForm })),
          detail: yield* service.get("custom"),
        }
      }).pipe(Effect.provide(fixture.layer)),
    )

    expect(result.save.code).toBe("write_failed")
    expect(result.detail.name).toBe("custom")
    expect(fixture.reconciles()).toEqual([])
  })

  test("maps a config write defect without exposing its detail or reconciling", async () => {
    const canary = "sensitive-write-canary"
    const fixture = managementFixture({ dieUpdate: canary })
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpManagement.Service
        return yield* Effect.flip(service.save({ name: "renamed", original_name: "custom", config: localForm }))
      }).pipe(Effect.provide(fixture.layer)),
    )

    expect(error.code).toBe("write_failed")
    expect(JSON.stringify(error)).not.toContain(canary)
    expect(String(error)).not.toContain(canary)
    expect(fixture.reconciles()).toEqual([])
  })

  test("preserves config write interruption", async () => {
    const fixture = managementFixture({ interruptUpdate: true })
    const interrupted = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpManagement.Service
        return yield* service.save({ name: "renamed", original_name: "custom", config: localForm }).pipe(
          Effect.as(false),
          Effect.catchCause((cause) => Effect.succeed(Cause.hasInterrupts(cause))),
        )
      }).pipe(Effect.provide(fixture.layer)),
    )

    expect(interrupted).toBe(true)
    expect(fixture.reconciles()).toEqual([])
  })
})
