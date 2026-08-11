import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { AddonApi } from "./groups/addon"
import { RegistryApi } from "./groups/registry"
import { AutomationApi } from "./groups/automation"
import { ConfigApi } from "./groups/config"
import { ControlApi } from "./groups/control"
import { EventApi } from "./event"
import { ExperimentalApi } from "./groups/experimental"
import { FileApi } from "./groups/file"
import { GlobalApi } from "./groups/global"
import { RemoteControlApi } from "./groups/remote-control"
import { InstanceApi } from "./groups/instance"
import { McpApi } from "./groups/mcp"
import { MemoryApi } from "./groups/memory"
import { PermissionApi } from "./groups/permission"
import { ProjectApi } from "./groups/project"
import { ProviderApi } from "./groups/provider"
import { PtyApi, PtyConnectApi } from "./groups/pty"
import { QuestionApi } from "./groups/question"
import { SessionApi } from "./groups/session"
import { SyncApi } from "./groups/sync"
import { TuiApi } from "./groups/tui"
import { WanlaiCodeUserCenterApi } from "./groups/wanlaicode-user-center"
import { WorkspaceApi } from "./groups/workspace"
import { V2Api } from "./groups/v2"

// SSE event schemas built from the same BusEvent/SyncEvent registries that
// the Hono spec uses, so both specs emit identical Event/SyncEvent components.
const EventSchema = Schema.Union(BusEvent.effectPayloads()).annotate({ identifier: "Event" })
const SyncEventSchemas = SyncEvent.effectPayloads()

// remote-control 是全局桌面能力，不绑定某个 directory 实例。
export const RootHttpApi = HttpApi.make("opencode-root")
  .addHttpApi(ControlApi)
  .addHttpApi(GlobalApi)
  .addHttpApi(RemoteControlApi)

export const InstanceHttpApi = HttpApi.make("opencode-instance")
  .addHttpApi(AddonApi)
  .addHttpApi(AutomationApi)
  .addHttpApi(ConfigApi)
  .addHttpApi(ExperimentalApi)
  .addHttpApi(FileApi)
  .addHttpApi(InstanceApi)
  .addHttpApi(McpApi)
  .addHttpApi(MemoryApi)
  .addHttpApi(ProjectApi)
  .addHttpApi(PtyApi)
  .addHttpApi(QuestionApi)
  .addHttpApi(PermissionApi)
  .addHttpApi(ProviderApi)
  .addHttpApi(SessionApi)
  .addHttpApi(SyncApi)
  .addHttpApi(V2Api)
  .addHttpApi(TuiApi)
  .addHttpApi(WanlaiCodeUserCenterApi)
  .addHttpApi(WorkspaceApi)
  .addHttpApi(RegistryApi)

export const OpenCodeHttpApi = HttpApi.make("opencode")
  .addHttpApi(RootHttpApi)
  .addHttpApi(EventApi)
  .addHttpApi(InstanceHttpApi)
  .addHttpApi(PtyConnectApi)
  .annotate(HttpApi.AdditionalSchemas, [EventSchema, ...SyncEventSchemas])

export type RootHttpApiType = typeof RootHttpApi
export type InstanceHttpApiType = typeof InstanceHttpApi
