import type { FetchImpl } from "../http-source"

// 后端成功码（Step 1 确认为 0）。
const SUCCESS_CODE = 0

export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly status: number,
  ) {
    super(message)
    this.name = "RegistryError"
  }
}

export interface RegistrySkillInfo {
  name: string
  description: string
}

export interface RegistryManifestInfo {
  capabilities: string[]
  default_prompts: string[]
  screenshots: string[]
  skills: RegistrySkillInfo[]
  brand_color: string | null
  category: string | null
  developer_name: string | null
  long_description: string | null
  privacy_policy_url: string | null
  short_description: string | null
  terms_of_service_url: string | null
  website_url: string | null
}

export interface RegistryPluginOut {
  namespace: string
  slug: string
  locale: string
  default_locale: string
  available_locales: string[]
  display_name: string
  // 后端已把描述统一为 short/long（locale 协商），不再有顶层 description 字段。
  short_description?: string | null
  long_description?: string | null
  download_count: number
  rating_avg: number
  rating_count: number
  comment_count: number
  created_at: string
  updated_at: string
  latest_version: string | null
  logo_url: string | null
  category: string | null
}

export interface RegistryVersionOut {
  version: string
  size_bytes: number
  checksum: string
  download_count: number
  created_at: string
  manifest_json?: unknown
}

export interface RegistryPluginDetail extends RegistryPluginOut {
  manifest: RegistryManifestInfo | null
  versions: RegistryVersionOut[]
}

export interface RegistryPage<T> {
  items: T[]
  total: number
  page: number
  per_page: number
}

// 列表项(CommentWithAuthor)带 author；创建响应(CommentOut)不带——故 author 字段可选。
export interface RegistryComment {
  id: string
  author_uuid?: string
  username?: string
  content: string
  created_at: string
  updated_at: string
}

// Fields from live OpenAPI: RatingOut schema
export interface RegistryRating {
  rating: number
  created_at: string
  updated_at: string
}

export interface RegistryUser {
  wanlai_uuid: string
  email: string
  username: string
  role: string
  status: string
  namespace: string | null
  created_at: string
  updated_at: string
}

export interface RegistryNamespaceOut {
  namespace: string
}

export interface ListPluginsParams {
  q?: string
  page?: number
  per_page?: number
  sort?: string
  locale?: string
}

export interface RegistryClientOptions {
  baseUrl: string
  fetchImpl?: FetchImpl
  token?: string
}

export interface RegistryClient {
  me(): Promise<RegistryUser>
  createNamespace(name: string): Promise<RegistryNamespaceOut>
  listPlugins(params: ListPluginsParams): Promise<RegistryPage<RegistryPluginOut>>
  getPlugin(ns: string, slug: string, params?: { locale?: string }): Promise<RegistryPluginDetail>
  deletePlugin(ns: string, slug: string): Promise<void>
  listVersions(ns: string, slug: string): Promise<RegistryVersionOut[]>
  resolveDownloadUrl(ns: string, slug: string, version: string): string
  listComments(ns: string, slug: string, params?: { page?: number }): Promise<RegistryPage<RegistryComment>>
  postComment(ns: string, slug: string, content: string): Promise<RegistryComment>
  deleteComment(ns: string, slug: string, publicId: string): Promise<void>
  getMyRating(ns: string, slug: string): Promise<RegistryRating | null>
  putRating(ns: string, slug: string, value: number): Promise<RegistryRating>
  deleteRating(ns: string, slug: string): Promise<void>
  publishPlugin(input: { namespace: string; slug: string; file: Blob; filename: string }): Promise<unknown>
  deleteVersion(ns: string, slug: string, version: string): Promise<void>
}

export function createRegistryClient(opts: RegistryClientOptions): RegistryClient {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  const root = opts.baseUrl.replace(/\/+$/, "")

  const request = async (method: string, pathAndQuery: string, body?: unknown) => {
    const headers = new Headers({ accept: "application/json" })
    if (opts.token) headers.set("authorization", `Bearer ${opts.token}`)
    if (body !== undefined) headers.set("content-type", "application/json")
    let res: Response
    try {
      res = await fetchImpl(`${root}${pathAndQuery}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (e) {
      // 网络层失败（不可达 / DNS / 超时）：包成 RegistryError，让 handlers/registry.ts 的 mapErr
      // 映射成结构化请求错误(400)，而非当作未知缺陷 Effect.die 成裸 HTTP 500。
      throw new RegistryError(`无法连接插件市场: ${e instanceof Error ? e.message : String(e)}`, -1, 0)
    }
    const text = await res.text().catch(() => "")
    let envelope: { code: number; message: string; data: unknown }
    try {
      envelope = text
        ? (JSON.parse(text) as { code: number; message: string; data: unknown })
        : { code: SUCCESS_CODE, message: "", data: null }
    } catch {
      // 非 JSON 响应（反代 502/504 的 HTML 错误页、网关超时页等）：同样包成 RegistryError。
      throw new RegistryError(`插件市场响应异常 (HTTP ${res.status})`, -1, res.status)
    }
    if (envelope.code !== SUCCESS_CODE) {
      throw new RegistryError(envelope.message || `registry request failed (${res.status})`, envelope.code, res.status)
    }
    return envelope.data
  }

  const requestForm = async (method: string, pathAndQuery: string, form: FormData) => {
    const headers = new Headers({ accept: "application/json" })
    if (opts.token) headers.set("authorization", `Bearer ${opts.token}`)
    let res: Response
    try {
      res = await fetchImpl(`${root}${pathAndQuery}`, { method, headers, body: form })
    } catch (e) {
      throw new RegistryError(`无法连接插件市场: ${e instanceof Error ? e.message : String(e)}`, -1, 0)
    }
    const text = await res.text().catch(() => "")
    let envelope: { code: number; message: string; data: unknown }
    try {
      envelope = text
        ? (JSON.parse(text) as { code: number; message: string; data: unknown })
        : { code: SUCCESS_CODE, message: "", data: null }
    } catch {
      throw new RegistryError(`插件市场响应异常 (HTTP ${res.status})`, -1, res.status)
    }
    if (envelope.code !== SUCCESS_CODE) {
      throw new RegistryError(envelope.message || `registry request failed (${res.status})`, envelope.code, res.status)
    }
    return envelope.data
  }

  const enc = encodeURIComponent
  const pluginPath = (ns: string, slug: string) => `/api/v1/plugins/${enc(ns)}/${enc(slug)}`
  const query = (params: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") sp.set(k, String(v))
    }
    const s = sp.toString()
    return s ? `?${s}` : ""
  }

  return {
    me: async () => (await request("GET", "/api/v1/me")) as RegistryUser,
    createNamespace: async (name) =>
      (await request("POST", "/api/v1/namespaces", { name })) as RegistryNamespaceOut,
    listPlugins: async (params) =>
      (await request(
        "GET",
        `/api/v1/plugins${query({ q: params.q, page: params.page, per_page: params.per_page, sort: params.sort, locale: params.locale })}`,
      )) as RegistryPage<RegistryPluginOut>,
    getPlugin: async (ns, slug, params) =>
      (await request("GET", `${pluginPath(ns, slug)}${query({ locale: params?.locale })}`)) as RegistryPluginDetail,
    deletePlugin: async (ns, slug) => {
      await request("DELETE", pluginPath(ns, slug))
    },
    listVersions: async (ns, slug) =>
      (await request("GET", `${pluginPath(ns, slug)}/versions`)) as RegistryVersionOut[],
    resolveDownloadUrl: (ns, slug, version) => `${root}${pluginPath(ns, slug)}/versions/${enc(version)}/download`,
    listComments: async (ns, slug, params) =>
      (await request(
        "GET",
        `${pluginPath(ns, slug)}/comments${query({ page: params?.page })}`,
      )) as RegistryPage<RegistryComment>,
    // CommentBody uses `content` field per live OpenAPI spec
    postComment: async (ns, slug, content) =>
      (await request("POST", `${pluginPath(ns, slug)}/comments`, { content })) as RegistryComment,
    deleteComment: async (ns, slug, publicId) => {
      await request("DELETE", `${pluginPath(ns, slug)}/comments/${enc(publicId)}`)
    },
    getMyRating: async (ns, slug) => (await request("GET", `${pluginPath(ns, slug)}/rating`)) as RegistryRating | null,
    // RatingBody uses `rating` field per live OpenAPI spec
    putRating: async (ns, slug, value) =>
      (await request("PUT", `${pluginPath(ns, slug)}/rating`, { rating: value })) as RegistryRating,
    deleteRating: async (ns, slug) => {
      await request("DELETE", `${pluginPath(ns, slug)}/rating`)
    },
    publishPlugin: async (input) => {
      const form = new FormData()
      form.set("file", input.file, input.filename)
      return requestForm("POST", `${pluginPath(input.namespace, input.slug)}/versions`, form)
    },
    deleteVersion: async (ns, slug, version) => {
      await request("DELETE", `${pluginPath(ns, slug)}/versions/${enc(version)}`)
    },
  }
}
