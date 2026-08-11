import { describe, expect, test } from "bun:test"
import type { McpManagementDetail } from "@opencode-ai/sdk/v2"
import {
  createEditorDrafts,
  createEmptyMcpDraft,
  detailToDraft,
  draftToSaveInput,
  isMcpRowEmpty,
  isMcpFieldValidationVisible,
  validateMcpDraft,
} from "./mcp-editor-form"

describe("MCP editor drafts", () => {
  test("tracks field interaction separately from full validation", async () => {
    const editor = await Bun.file(new URL("./mcp-editor.tsx", import.meta.url)).text()

    expect(editor).toContain("const [touchedFields, setTouchedFields] = createSignal<Set<string>>(new Set())")
    expect(editor).toContain("data-mcp-field=\"name\"")
    expect(editor).toContain("setValidateAll(true)")
    expect(editor).toContain("disabled={saveDisabled()}")
    expect(editor).not.toContain("onInput={() => setShowValidation(true)}")
  })

  test("uses the Codex editor shell hierarchy", async () => {
    const editor = await Bun.file(new URL("./mcp-editor.tsx", import.meta.url)).text()
    const styles = await Bun.file(new URL("../index.css", import.meta.url)).text()

    expect(editor).toContain('data-page="mcp-editor"')
    expect(editor).toContain("ManagePageHeader")
    expect(editor).toContain("max-w-[1040px]")
    expect(editor).toContain("pt-[85px]")
    expect(editor).toContain("text-[28px]")
    expect(editor).toContain("flex justify-end")
    expect(editor).not.toContain("sticky bottom-0")
    expect(editor).toContain("rounded-[20px] border border-border-weaker-base bg-background-stronger")
    expect(editor).toContain('data-mcp-panel="url"')
    expect(editor).toContain('data-mcp-panel="bearer"')
    expect(editor).toContain('data-mcp-action="uninstall"')
    expect(editor).toContain('data-mcp-action="save"')
    expect(editor).toContain("bg-input-base")
    expect(editor).toContain("border border-dashed")
    expect(editor).toContain("bg-background-base")
    expect(editor).toContain("w-full justify-center")
    expect(editor).toContain('language.t("mcp.editor.docs")')
    expect(styles).toContain("--color-background-stronger: var(--background-stronger)")
    expect(styles).toContain("--color-input-base: var(--input-base)")
  })

  test("matches the Codex destructive action treatment", async () => {
    const editor = await Bun.file(new URL("./mcp-editor.tsx", import.meta.url)).text()
    const styles = await Bun.file(new URL("../index.css", import.meta.url)).text()

    expect(editor).toContain('<Icon name="trash-codex" size="normal" />')
    expect(styles).toContain("--mcp-uninstall-color: #e02e2a")
    expect(styles).toContain("--color-surface-critical-weak: rgb(224 46 42 / 10%)")
    expect(styles).toContain('[data-mcp-action="uninstall"]:hover:not(:disabled)')
    expect(styles).toContain("--color-surface-critical-weak: rgb(224 46 42 / 20%)")
    expect(styles).toContain('[data-mcp-action="uninstall"]:not(:disabled) [data-slot="icon-svg"]')
  })

  test("keeps blank dynamic rows outside validation", () => {
    expect(isMcpRowEmpty({ key: "  ", value: "\n" })).toBe(true)
    expect(isMcpRowEmpty({ key: "X-Tenant", value: "" })).toBe(false)
    expect(isMcpRowEmpty({ key: "", value: "value" })).toBe(false)
  })

  test("starts both editor modes with visible blank dynamic rows", () => {
    const drafts = createEditorDrafts()

    expect(drafts.local.args).toEqual([""])
    expect(drafts.local.environment).toEqual([{ key: "", value: "" }])
    expect(drafts.local.inherited_environment).toEqual([""])
    expect(drafts.remote.headers).toEqual([{ key: "", value: "" }])
    expect(drafts.remote.environment_headers).toEqual([{ key: "", env: "" }])
    expect(validateMcpDraft(drafts.local)).not.toHaveProperty("environment.0.key")
    expect(validateMcpDraft(drafts.remote)).not.toHaveProperty("headers.0.key")
  })

  test("keeps OAuth advanced configuration visible on the update page", async () => {
    const editor = await Bun.file(new URL("./mcp-editor.tsx", import.meta.url)).text()

    expect(editor).toContain('data-editor-mode={creating() ? "create" : "edit"}')
    expect(editor).toContain('language.t("plugins.detail.uninstall")')
    expect(editor).toContain('id="oauth-advanced"')
    expect(editor).not.toContain("compact={!creating()}")
    expect(editor).toContain("disabled={saveDisabled()}")
  })

  test("shows field errors independently until full validation is requested", () => {
    const touched = new Set(["name"])

    expect(isMcpFieldValidationVisible("name", touched, false)).toBe(true)
    expect(isMcpFieldValidationVisible("command", touched, false)).toBe(false)
    expect(isMcpFieldValidationVisible("command", touched, true)).toBe(true)
  })

  test("keeps independent local and remote drafts while switching type", () => {
    const drafts = createEditorDrafts()
    drafts.local.command = "npx"
    drafts.remote.url = "https://mcp.example.com/mcp"

    expect(drafts.local.command).toBe("npx")
    expect(drafts.remote.url).toBe("https://mcp.example.com/mcp")
    expect(drafts.remote.oauth.enabled).toBe(true)
  })

  test("maps management details into editable fields without inventing secrets", () => {
    const detail: McpManagementDetail = {
      name: "demo",
      source: "custom",
      type: "remote",
      enabled: true,
      editable: true,
      status: { status: "connected" },
      supports_oauth: true,
      config: {
        type: "remote",
        url: "https://mcp.example.com/mcp",
        bearer_token_configured: true,
        headers: [{ key: "X-Tenant", value: "wanlai" }],
        environment_headers: [{ key: "X-Account", env: "MCP_ACCOUNT" }],
        oauth: {
          enabled: true,
          client_id: "desktop",
          client_secret_configured: true,
          redirect_uri: "http://127.0.0.1:19876/mcp/oauth/callback",
        },
        timeout: 10_000,
      },
    }

    const draft = detailToDraft(detail)

    expect(draft).toMatchObject({
      name: "demo",
      type: "remote",
      bearer_token_env: "",
      bearer_token_configured: true,
      oauth: {
        client_secret_env: "",
        client_secret_configured: true,
      },
      timeout: "10000",
    })
  })

  test("drops fully empty rows and reports half-filled rows", () => {
    const draft = createEmptyMcpDraft("remote")
    draft.name = "demo"
    draft.url = "https://mcp.example.com/mcp"
    draft.headers = [
      { key: "", value: "" },
      { key: "X-Tenant", value: "" },
    ]

    expect(validateMcpDraft(draft)).toEqual({
      "headers.1.value": "value_required",
    })
    expect(draftToSaveInput(draft, undefined).config).toMatchObject({
      headers: [{ key: "X-Tenant", value: "" }],
    })
  })

  test("normalizes dynamic rows and optional fields before save", () => {
    const draft = createEmptyMcpDraft("local")
    draft.name = " demo "
    draft.command = " npx "
    draft.args = [" -y ", "  "]
    draft.environment = [
      { key: " MODE ", value: " read-only " },
      { key: "", value: "" },
    ]
    draft.inherited_environment = [" GITHUB_TOKEN ", ""]
    draft.cwd = " ~/code "
    draft.timeout = "10000"

    expect(draftToSaveInput(draft, "old-name")).toEqual({
      name: "demo",
      original_name: "old-name",
      config: {
        type: "local",
        command: "npx",
        args: ["-y"],
        environment: [{ key: "MODE", value: "read-only" }],
        inherited_environment: ["GITHUB_TOKEN"],
        cwd: "~/code",
        timeout: 10_000,
      },
    })
  })

  test("maps bearer and oauth secret env names without literal secrets", () => {
    const input = draftToSaveInput(
      {
        ...createEmptyMcpDraft("remote"),
        name: "demo",
        url: "https://mcp.example.com/mcp",
        bearer_token_env: "MCP_TOKEN",
        oauth: {
          enabled: true,
          client_id: "",
          client_secret_env: "MCP_CLIENT_SECRET",
          client_secret_configured: false,
          scope: "",
          redirect_uri: "",
        },
      },
      undefined,
    )

    expect(input.config).toMatchObject({
      bearer_token_env: "MCP_TOKEN",
      oauth: { enabled: true, client_secret_env: "MCP_CLIENT_SECRET" },
    })
    expect(JSON.stringify(input)).not.toContain("literal")
  })

  test("omits automatic OAuth without advanced fields and preserves an explicit opt-out", () => {
    const automatic = createEmptyMcpDraft("remote")
    automatic.name = "automatic"
    automatic.url = "https://mcp.example.com/mcp"

    expect(draftToSaveInput(automatic, undefined).config).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: [],
      environment_headers: [],
    })

    automatic.oauth.enabled = false
    expect(draftToSaveInput(automatic, undefined).config).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: [],
      environment_headers: [],
      oauth: false,
    })
  })

  test("round-trips configured OAuth credentials without exposing or dropping them", () => {
    const detail: McpManagementDetail = {
      name: "configured",
      source: "custom",
      type: "remote",
      enabled: true,
      editable: true,
      status: { status: "connected" },
      supports_oauth: true,
      config: {
        type: "remote",
        url: "https://mcp.example.com/mcp",
        headers: [],
        environment_headers: [],
        oauth: {
          enabled: true,
          client_secret_configured: true,
        },
      },
    }

    const input = draftToSaveInput(detailToDraft(detail), detail.name)

    expect(input.config).toMatchObject({
      oauth: {
        enabled: true,
        client_secret_configured: true,
      },
    })
    expect(JSON.stringify(input)).not.toContain("client_secret_env")
  })

  test("maps omitted OAuth to automatic discovery and false to an explicit opt-out", () => {
    const detail = (oauth: false | undefined): McpManagementDetail => ({
      name: "remote",
      source: "custom",
      type: "remote",
      enabled: true,
      editable: true,
      status: { status: "connected" },
      supports_oauth: oauth !== false,
      config: {
        type: "remote",
        url: "https://mcp.example.com/mcp",
        headers: [],
        environment_headers: [],
        ...(oauth === undefined ? {} : { oauth }),
      },
    })

    expect(detailToDraft(detail(undefined))).toMatchObject({
      oauth: { enabled: true },
    })
    expect(detailToDraft(detail(false))).toMatchObject({
      oauth: { enabled: false },
    })
  })

  test("never sends ordinary Authorization rows even before validation", () => {
    const draft = createEmptyMcpDraft("remote")
    draft.name = "demo"
    draft.url = "https://mcp.example.com/mcp"
    draft.headers = [{ key: "Authorization", value: "Bearer literal-token" }]
    draft.environment_headers = [{ key: "authorization", env: "MCP_TOKEN" }]

    const input = draftToSaveInput(draft, undefined)

    expect(input.config).toMatchObject({
      headers: [],
      environment_headers: [],
    })
    expect(JSON.stringify(input)).not.toContain("literal-token")
  })
})

describe("MCP editor validation", () => {
  test("reports required and malformed names at the name field", () => {
    expect(validateMcpDraft(createEmptyMcpDraft("local"))).toMatchObject({
      name: "name_required",
      command: "command_required",
    })

    const draft = createEmptyMcpDraft("local")
    draft.name = "bad name"
    draft.command = "npx"
    expect(validateMcpDraft(draft)).toEqual({ name: "name_invalid" })
  })

  test("accepts the full server-name grammar and enforces its exact boundaries", () => {
    const cases = [
      { name: "a.b_c-d", error: undefined },
      { name: `a${"b".repeat(63)}`, error: undefined },
      { name: "-leading", error: "name_invalid" },
      { name: "_leading", error: "name_invalid" },
      { name: `a${"b".repeat(64)}`, error: "name_invalid" },
    ] as const

    cases.forEach((item) => {
      const draft = createEmptyMcpDraft("local")
      draft.name = item.name
      draft.command = "npx"
      if (item.error) {
        expect(validateMcpDraft(draft).name).toBe(item.error)
        return
      }
      expect(validateMcpDraft(draft).name).toBeUndefined()
    })
  })

  test("reports invalid URL, timeout, and OAuth redirect fields", () => {
    const draft = createEmptyMcpDraft("remote")
    draft.name = "demo"
    draft.url = "file:///tmp/mcp"
    draft.timeout = "1.5"
    draft.oauth.enabled = true
    draft.oauth.redirect_uri = "file:///tmp/callback"

    expect(validateMcpDraft(draft)).toEqual({
      url: "url_invalid",
      timeout: "timeout_invalid",
      "oauth.redirect_uri": "redirect_uri_invalid",
    })
  })

  test("accepts blank or positive integer timeouts before converting a save payload", () => {
    const cases = [
      { value: "", timeout: undefined },
      { value: "   ", timeout: undefined },
      { value: "1", timeout: 1 },
      { value: "10000", timeout: 10_000 },
    ] as const

    cases.forEach((item) => {
      const draft = createEmptyMcpDraft("local")
      draft.name = "demo"
      draft.command = "npx"
      draft.timeout = item.value

      expect(validateMcpDraft(draft).timeout).toBeUndefined()
      expect(draftToSaveInput(draft, undefined).config.timeout).toBe(item.timeout)
    })
  })

  test("rejects non-finite, non-positive, and fractional timeouts", () => {
    const invalid = ["NaN", "Infinity", "0", "-1", "1.5"]
    invalid.forEach((timeout) => {
      const draft = createEmptyMcpDraft("local")
      draft.name = "demo"
      draft.command = "npx"
      draft.timeout = timeout

      expect(validateMcpDraft(draft)).toEqual({ timeout: "timeout_invalid" })
    })
  })

  test("reports malformed environment variable names on their exact fields", () => {
    const local = createEmptyMcpDraft("local")
    local.name = "local"
    local.command = "npx"
    local.environment = [{ key: "bad-name", value: "value" }]
    local.inherited_environment = ["ALSO-BAD"]
    expect(validateMcpDraft(local)).toEqual({
      "environment.0.key": "env_invalid",
      "inherited_environment.0": "env_invalid",
    })

    const remote = createEmptyMcpDraft("remote")
    remote.name = "remote"
    remote.url = "https://mcp.example.com/mcp"
    remote.bearer_token_env = "bad-token"
    remote.environment_headers = [{ key: "X-Account", env: "bad-account" }]
    remote.oauth.client_secret_env = "bad-secret"
    expect(validateMcpDraft(remote)).toEqual({
      bearer_token_env: "env_invalid",
      "environment_headers.0.env": "env_invalid",
      "oauth.client_secret_env": "env_invalid",
    })
  })

  test("reports missing keys and values for all half-filled row types", () => {
    const local = createEmptyMcpDraft("local")
    local.name = "local"
    local.command = "npx"
    local.environment = [
      { key: "", value: "value" },
      { key: "MODE", value: "" },
    ]
    expect(validateMcpDraft(local)).toEqual({
      "environment.0.key": "key_required",
      "environment.1.value": "value_required",
    })

    const remote = createEmptyMcpDraft("remote")
    remote.name = "remote"
    remote.url = "https://mcp.example.com/mcp"
    remote.environment_headers = [
      { key: "", env: "MCP_ACCOUNT" },
      { key: "X-Account", env: "" },
    ]
    expect(validateMcpDraft(remote)).toEqual({
      "environment_headers.0.key": "key_required",
      "environment_headers.1.env": "value_required",
    })
  })

  test("reports case-insensitive duplicate keys at later fields", () => {
    const local = createEmptyMcpDraft("local")
    local.name = "local"
    local.command = "npx"
    local.environment = [{ key: "MODE", value: "read-only" }]
    local.inherited_environment = ["mode"]
    expect(validateMcpDraft(local)).toEqual({
      "inherited_environment.0": "duplicate_key",
    })

    const remote = createEmptyMcpDraft("remote")
    remote.name = "remote"
    remote.url = "https://mcp.example.com/mcp"
    remote.headers = [{ key: "X-Tenant", value: "wanlai" }]
    remote.environment_headers = [{ key: "x-tenant", env: "MCP_TENANT" }]
    expect(validateMcpDraft(remote)).toEqual({
      "environment_headers.0.key": "duplicate_key",
    })
  })

  test("rejects Authorization in either ordinary header collection", () => {
    const draft = createEmptyMcpDraft("remote")
    draft.name = "demo"
    draft.url = "https://mcp.example.com/mcp"
    draft.headers = [{ key: "authorization", value: "Bearer plaintext" }]
    draft.environment_headers = [{ key: "AUTHORIZATION", env: "MCP_TOKEN" }]

    expect(validateMcpDraft(draft)).toEqual({
      "headers.0.key": "authorization_conflict",
      "environment_headers.0.key": "authorization_conflict",
    })
  })
})
