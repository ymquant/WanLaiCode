import { describe, expect, test } from "bun:test"
import { hasUserInterjection } from "../../src/session/prompt"
import type { MessageV2 } from "../../src/session/message-v2"

// 构造一条 user 消息;只关心 id / turnID / automationID 与 part 的 text/synthetic/ignored
function user(
  id: string,
  opts: {
    turnID?: string
    automationID?: string
    text?: string
    synthetic?: boolean
    ignored?: boolean
  } = {},
): MessageV2.WithParts {
  return {
    info: { id, role: "user", turnID: opts.turnID, automationID: opts.automationID },
    parts:
      opts.text === undefined
        ? []
        : [{ type: "text", text: opts.text, synthetic: opts.synthetic, ignored: opts.ignored }],
  } as unknown as MessageV2.WithParts
}

function assistant(id: string): MessageV2.WithParts {
  return { info: { id, role: "assistant" }, parts: [] } as unknown as MessageV2.WithParts
}

const ROOT = "msg_root"
// 自动化触发消息:回合根,turnID 即自身 id
const root = user(ROOT, { turnID: ROOT, automationID: "atm_1", text: "汇总新闻" })
const rootInfo = root.info as MessageV2.User

describe("hasUserInterjection", () => {
  test("只有自动化触发消息时不算插话", () => {
    expect(hasUserInterjection([root, assistant("msg_a")], rootInfo)).toBe(false)
  })

  test("本回合内用户手输的插话算", () => {
    const msgs = [root, assistant("msg_a"), user("msg_steer", { turnID: ROOT, text: "顺便看看昨天的" })]
    expect(hasUserInterjection(msgs, rootInfo)).toBe(true)
  })

  // 最关键的回归:传进来的 messages 是**整个会话历史**,不是当前回合。
  // thread 模式的自动化跑在用户自己的对话里,历史里必然有用户以前发的消息 ——
  // 不按 turnID 收窄就恒为真,等于把无人值守契约与工具屏蔽全程关掉(主 bug 复发)。
  test("会话历史里的旧消息不算插话", () => {
    const msgs = [
      user("msg_old1", { turnID: "turn_old1", text: "帮我看下这个项目" }),
      assistant("msg_olda"),
      user("msg_old2", { turnID: "turn_old2", text: "再改一下" }),
      assistant("msg_oldb"),
      root,
    ]
    expect(hasUserInterjection(msgs, rootInfo)).toBe(false)
  })

  test("旧回合有插话、当前回合没有 → 仍判为无插话", () => {
    const msgs = [
      user("msg_old", { turnID: "turn_old", text: "问题一" }),
      user("msg_old_steer", { turnID: "turn_old", text: "补充一句" }),
      root,
    ]
    expect(hasUserInterjection(msgs, rootInfo)).toBe(false)
  })

  // 多步回合里压缩续跑/子任务会插入内部合成消息,误判成插话会让契约在回合中途丢失
  test("内部合成消息(synthetic/ignored/空白)不算插话", () => {
    for (const extra of [
      user("msg_c", { turnID: ROOT, text: "继续", synthetic: true }),
      user("msg_c", { turnID: ROOT, text: "", ignored: true }),
      user("msg_c", { turnID: ROOT, text: "   " }),
      user("msg_c", { turnID: ROOT }),
    ]) {
      expect(hasUserInterjection([root, extra], rootInfo)).toBe(false)
    }
  })

  test("带 automationID 的消息一律不算插话(自动化自己注入的)", () => {
    const again = user("msg_2", { turnID: ROOT, automationID: "atm_1", text: "又一次注入" })
    expect(hasUserInterjection([root, again], rootInfo)).toBe(false)
  })

  test("没有回合根时不算插话(防御性:调用方本就只在自动化回合里用它)", () => {
    expect(hasUserInterjection([user("m", { text: "x" })], undefined)).toBe(false)
  })
})
