import { describe, expect, test } from "bun:test"

const REQUIRED = [
  "sidebar.global.automations",
  "automation.title",
  "automation.subtitle",
  "automation.learnMore",
  "automation.empty.title",
  "automation.viewTemplates",
  "automation.createViaChat",
  "automation.createManually",
  "automation.template.dailyBrief",
  "automation.template.weeklyReview",
  "automation.template.projectMonitor",
  "automation.suggestions.title",
  "automation.suggestion.dailyBrief.description",
  "automation.suggestion.weeklyReview.description",
  "automation.suggestion.projectMonitor.description",
  // 任务提示词的标签与帮助文案:防止用户把排期语义写进任务提示词(线上主 bug 的同源风险)
  "automation.editor.promptLabel",
  "automation.editor.promptHelp",
  // 运行历史的触发方式
  "automation.run.triggerSchedule",
  "automation.run.triggerManual",
]

describe("automation i18n keys", () => {
  for (const locale of ["zh", "en"]) {
    test(`${locale} defines all automation keys (uncommented)`, async () => {
      const src = await Bun.file(new URL(`./${locale}.ts`, import.meta.url)).text()
      for (const key of REQUIRED) {
        const re = new RegExp(`^\\s*"${key.replace(/\./g, "\\.")}"\\s*:`, "m")
        expect(re.test(src), `${locale}.ts missing ${key}`).toBe(true)
      }
    })
  }
})
