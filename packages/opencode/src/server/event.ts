import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"
import "@/provider/wanlaicode-user-center-events"
import "@/permission/mode"

export const Event = {
  Connected: BusEvent.define("server.connected", Schema.Struct({})),
  ConfigUpdated: BusEvent.define("global.config.updated", Schema.Struct({})),
  Disposed: BusEvent.define("global.disposed", Schema.Struct({})),
  // 手机新建目录后通知桌面渲染层加入项目列表；只同步列表状态，不抢占用户当前页面。
  ProjectOpenRequested: BusEvent.define("project.open.requested", Schema.Struct({ directory: Schema.String })),
}
