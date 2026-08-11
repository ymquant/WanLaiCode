import type { Info } from "./schema"

// 自动化运行时不应暴露给模型的工具(对照 Codex 的多层软约束,本项目直接按能力封禁):
// - question:无人值守回合里没有用户能回答
// - automation_create:自动化「已经存在」,运行回合再暴露创建入口会让模型把任务提示词
//   重新理解成一次「请帮我建自动化」的请求并反问用户确认(线上主 bug 的直接成因)。
//   Codex 靠 automation_update 懒加载 + 「仅当用户提出要求时才搜」+ 「先查后 upsert」四层软约束
//   规避;本项目没有懒加载工具的机制,也没有 update/delete 工具(即无自维护能力可损失),
//   因此直接从工具集里摘掉是等价且更强的护栏。
export const RUN_BLOCKED_TOOLS: ReadonlySet<string> = new Set(["question", "automation_create"])

// 注入消息的元信息头(对照 Codex cron 的 `Automation: <name>\nAutomation ID: <id>\nLast run: …`)。
// 是「这不是一次普通用户请求」的第一层信号,并让模型知道距上次运行多久、可做增量。
// 作为 synthetic part 注入:thread(对话)模式复用的是用户自己的置顶对话,把内部 ID 当成
// 用户气泡渲染出来会污染对话(Codex 的 heartbeat 同样在渲染层把包装剥掉不显示)。
// 不抄 Codex 的 `Automation memory:` 一行:本项目没有 automations/<id>/memory.md 那套机制,
// 写了只会让模型去读一个不存在的文件。
export function runHeader(automation: Pick<Info, "id" | "title" | "lastRunAt">): string {
  const lastRun = automation.lastRunAt
    ? `${new Date(automation.lastRunAt).toISOString()} (${automation.lastRunAt})`
    : "never"
  return [`Automation: ${automation.title}`, `Automation ID: ${automation.id}`, `Last run: ${lastRun}`].join("\n")
}

// 自动化运行的执行契约。作为 <system-reminder> 合成 part 追加到触发消息末尾(不展示给用户),
// 与语言提醒同一机制 —— 模型对最新用户轮的约束权重最高。
// 对照 Codex:cron 的 developer instructions(「Try not to ask the user for more input if possible to infer.」)
// 与 heartbeat 的 `## Heartbeats` 段(「It is not actually sent by the user, but by the system…」)。
export function runContract(automationID: string): string {
  return [
    `你正在执行一个已保存的自动化(Automation ID ${automationID})的一次运行。这条消息不是用户发的,`,
    "是系统按用户配置的计划(或用户点了「立即运行」)注入的,当前没有用户在场等待交互。",
    "",
    "- 直接执行上面的任务并给出结果,不要把它当成一次需要澄清或需要立项的新请求。",
    "- 不要向用户提问、不要请求确认、不要等待回复。信息不足时按最合理的假设继续,并在结果里写明所用假设。",
    "- 不要创建、修改或删除任何自动化。这条自动化已经存在,它的运行计划和归属已由用户配置好;",
    "  任务描述里出现的「每天」「每周」「HH:MM」等时间措辞是排期的残留描述,不是让你去配置排期,",
    "  应当理解为「本次就按这个任务做一遍」。",
    "- 输出要自包含、可直接阅读:用户是事后打开这个会话查看结果的,看不到你的中间推理。",
    "- 确实无事可报时,简短说明本次检查的结论,不要留空回复。",
    "",
    "回复末尾必须单独起一行给出本次运行的收件箱条目(对照 Codex 的 ::inbox-item 指令),格式:",
    '::inbox-item{title="本次跑出了什么" summary="用户接下来该知道/该做什么"}',
    "- 必须独占一行,不能写在句子中间;整段回复只给一条。",
    "- title 写「现在是什么状态」,约 4-8 字;summary 写「用户接下来该知道或该做什么」,约 6-14 字。",
    "- 避免「更新」「完成」「已处理」这类没有信息量的词。",
    "- 这一行只用于自动化列表的摘要展示,不会显示在对话正文里。",
  ].join("\n")
}

export * as AutomationMessage from "./message"
