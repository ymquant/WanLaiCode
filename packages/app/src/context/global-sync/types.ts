import type {
  Agent,
  Command,
  Config,
  LspStatus,
  McpStatus,
  Message,
  Part,
  Path,
  PermissionRequest,
  ProviderListResponse,
  QuestionRequest,
  Session,
  SessionStatus,
  SnapshotFileDiff,
  Todo,
  VcsInfo,
} from "@opencode-ai/sdk/v2/client"
import type { Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
    setup?: string
    cleanup?: string
  }
  env?: Record<string, string>
}

export type PermissionReviewState = {
  id: string
  permissionID: string
  sessionID: string
  status: "reviewing" | "approved" | "denied" | "escalated" | "failed"
  risk?: "low" | "medium" | "high" | "critical"
  reason?: string
  summary: string
  startedAt: number
  completedAt?: number
}

export type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  command: Command[]
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider_ready: boolean
  provider: ProviderListResponse
  config: Config
  path: Path
  session: Session[]
  sessionTotal: number
  session_status: {
    [sessionID: string]: SessionStatus
  }
  // session_status 使用稀疏 map，idle 会话不保留 key；ready 单独区分“已确认 idle”和“快照尚未加载”。
  session_status_ready: boolean
  // bootstrap 前收到的单会话 status 事件只证明该会话状态已知，不能把其它缺失 key 一并解释为 idle。
  session_status_known: {
    [sessionID: string]: true | undefined
  }
  session_diff: {
    [sessionID: string]: SnapshotFileDiff[]
  }
  session_suggestion: {
    [sessionID: string]: string
  }
  todo: {
    [sessionID: string]: Todo[]
  }
  permission: {
    [sessionID: string]: PermissionRequest[]
  }
  permission_review: {
    [sessionID: string]: PermissionReviewState[]
  }
  question: {
    [sessionID: string]: QuestionRequest[]
  }
  mcp_ready: boolean
  mcp: {
    [name: string]: McpStatus
  }
  lsp_ready: boolean
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  limit: number
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
}

export type VcsCache = {
  store: Store<{ value: VcsInfo | undefined }>
  setStore: SetStoreFunction<{ value: VcsInfo | undefined }>
  ready: Accessor<boolean>
}

export type MetaCache = {
  store: Store<{ value: ProjectMeta | undefined }>
  setStore: SetStoreFunction<{ value: ProjectMeta | undefined }>
  ready: Accessor<boolean>
}

export type IconCache = {
  store: Store<{ value: string | undefined }>
  setStore: SetStoreFunction<{ value: string | undefined }>
  ready: Accessor<boolean>
}

export type ChildOptions = {
  bootstrap?: boolean
}

export type DirState = {
  lastAccessAt: number
}

export type EvictPlan = {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  max: number
  ttl: number
  now: number
}

export type DisposeCheck = {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
}

export type RootLoadArgs = {
  directory: string
  limit: number
  list: (query: {
    directory: string
    roots: true
    limit?: number
    scope?: "project"
  }) => Promise<{ data?: Session[] }>
}

export type RootLoadResult = {
  data?: Session[]
  limit: number
  limited: boolean
}

export const MAX_DIR_STORES = 30
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_RECENT_WINDOW = 4 * 60 * 60 * 1000
export const SESSION_RECENT_LIMIT = 50
