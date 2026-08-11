import { describe, expect, test } from "bun:test"
import type { CommandOption } from "@/context/command"
import { builtinSlashCommands, orderedSlashCommands } from "./slash-commands"

const command = (option: Partial<CommandOption> & Pick<CommandOption, "id" | "title">): CommandOption => ({
  ...option,
})

describe("builtinSlashCommands", () => {
  test("expands slash aliases while preserving the canonical command id", () => {
    const commands = builtinSlashCommands([
      command({
        id: "model.choose",
        title: "Choose model",
        slash: "model",
        slashAliases: ["models", "/switch-model"],
        keybind: "mod+'",
      }),
    ])

    expect(commands).toEqual([
      {
        id: "model.choose",
        commandID: "model.choose",
        trigger: "model",
        title: "Choose model",
        description: undefined,
        keybind: "mod+'",
        type: "builtin",
      },
      {
        id: "model.choose.slash.models",
        commandID: "model.choose",
        trigger: "models",
        title: "Choose model",
        description: undefined,
        keybind: "mod+'",
        type: "builtin",
      },
      {
        id: "model.choose.slash.switch-model",
        commandID: "model.choose",
        trigger: "switch-model",
        title: "Choose model",
        description: undefined,
        keybind: "mod+'",
        type: "builtin",
      },
    ])
  })

  test("filters disabled and suggested commands, and removes duplicate triggers", () => {
    const commands = builtinSlashCommands([
      command({
        id: "session.new",
        title: "New session",
        slash: "new",
        slashAliases: ["new", "/clear", "clear"],
      }),
      command({
        id: "session.disabled",
        title: "Disabled",
        slash: "disabled",
        disabled: true,
      }),
      command({
        id: "suggested.session.new",
        title: "Suggested",
        slash: "suggested-new",
      }),
    ])

    expect(commands.map((item) => ({ id: item.id, commandID: item.commandID, trigger: item.trigger }))).toEqual([
      { id: "session.new", commandID: "session.new", trigger: "new" },
      { id: "session.new.slash.clear", commandID: "session.new", trigger: "clear" },
    ])
  })

  test("maps bilingual plan mode aliases to the same command", () => {
    const commands = builtinSlashCommands([
      command({
        id: "prompt.plan",
        title: "计划模式",
        slash: "plan",
        slashAliases: ["计划", "計劃"],
      }),
    ])

    expect(commands.map((item) => ({ id: item.id, commandID: item.commandID, trigger: item.trigger }))).toEqual([
      { id: "prompt.plan", commandID: "prompt.plan", trigger: "plan" },
      { id: "prompt.plan.slash.计划", commandID: "prompt.plan", trigger: "计划" },
      { id: "prompt.plan.slash.計劃", commandID: "prompt.plan", trigger: "計劃" },
    ])
  })

  test("exposes forward and reverse agent cycle commands through slash triggers", () => {
    const commands = builtinSlashCommands([
      command({
        id: "agent.cycle",
        title: "切换智能体",
        slash: "agent",
        slashAliases: ["agents", "智能体"],
      }),
      command({
        id: "agent.cycle.reverse",
        title: "反向切换智能体",
        slash: "agent-reverse",
        slashAliases: ["agent-prev", "previous-agent", "上一智能体"],
      }),
    ])

    expect(commands.map((item) => ({ commandID: item.commandID, trigger: item.trigger }))).toEqual([
      { commandID: "agent.cycle", trigger: "agent" },
      { commandID: "agent.cycle", trigger: "agents" },
      { commandID: "agent.cycle", trigger: "智能体" },
      { commandID: "agent.cycle.reverse", trigger: "agent-reverse" },
      { commandID: "agent.cycle.reverse", trigger: "agent-prev" },
      { commandID: "agent.cycle.reverse", trigger: "previous-agent" },
      { commandID: "agent.cycle.reverse", trigger: "上一智能体" },
    ])
  })

  test("uses only the canonical slash trigger when no aliases are registered", () => {
    const commands = builtinSlashCommands([
      command({
        id: "session.goal",
        title: "Set goal",
        slash: "目标",
      }),
    ])

    expect(commands.map((item) => item.trigger)).toEqual(["目标"])
  })

  test("expands catalog typo alias to the session list command", () => {
    const commands = builtinSlashCommands([
      command({
        id: "session.list",
        title: "Switch session",
        slash: "sessions",
        slashAliases: ["resume", "continue", "catalog", "catlog"],
      }),
    ])

    expect(commands.find((item) => item.trigger === "catlog")).toMatchObject({
      commandID: "session.list",
      id: "session.list.slash.catlog",
      title: "Switch session",
      type: "builtin",
    })
  })
})

describe("orderedSlashCommands", () => {
  test("orders built-in slash commands before custom skill commands", () => {
    const sessionList = builtinSlashCommands([
      command({
        id: "session.list",
        title: "Switch session",
        slash: "sessions",
        slashAliases: ["catlog"],
      }),
    ])
    const commands = orderedSlashCommands({
      builtin: sessionList,
      custom: [
        {
          id: "custom.wanlaicode/build-web-data-visualization:cartographic",
          trigger: "wanlaicode/build-web-data-visualization:cartographic",
          title: "wanlaicode/build-web-data-visualization:cartographic",
          description: "Skill",
          type: "custom",
          source: "skill",
        },
      ],
    })

    expect(commands.map((item) => item.id)).toEqual([
      "session.list",
      "session.list.slash.catlog",
      "custom.wanlaicode/build-web-data-visualization:cartographic",
    ])
  })
})
