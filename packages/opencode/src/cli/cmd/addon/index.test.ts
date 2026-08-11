import { expect, test } from "bun:test"
import { renderAddonList, renderAddonSkillLine, renderAddonSummary } from "./index"

test("renders addon summary as a compact block", () => {
  const output = renderAddonSummary({
    manifest: {
      name: "github",
      version: "0.1.0",
      description: "Inspect repositories.",
      paths: {},
    },
    addonId: {
      addonName: "github",
      marketplaceName: "openai",
    },
    skills: [
      { name: "triage", description: "Triage issues", content: "", location: "/skills/triage/SKILL.md" },
      { name: "ci", description: "CI helper", content: "", location: "/skills/ci/SKILL.md" },
    ],
  })

  expect(output).toBe(
    [
      "github@openai",
      "  Version: 0.1.0",
      "  Description: Inspect repositories.",
      "  Features: 2 skills",
    ].join("\n"),
  )
})

test("renders disabled and error state", () => {
  const output = renderAddonSummary({
    manifest: {
      name: "github",
      version: "0.1.0",
      paths: {},
    },
    addonId: {
      addonName: "github",
      marketplaceName: "openai",
    },
    disabled: true,
    error: "Failed to parse manifest",
  })

  expect(output).toBe(
    [
      "github@openai",
      "  Version: 0.1.0",
      "  Status: disabled",
      "  Error: Failed to parse manifest",
    ].join("\n"),
  )
})

test("renders addon list as separate blocks", () => {
  const output = renderAddonList([
    {
      manifest: {
        name: "github",
        version: "0.1.0",
        paths: {},
      },
      addonId: {
        addonName: "github",
        marketplaceName: "openai",
      },
    },
    {
      manifest: {
        name: "superpowers",
        version: "5.1.0",
        paths: {},
      },
      addonId: {
        addonName: "superpowers",
        marketplaceName: "openai",
      },
    },
  ])

  expect(output).toEqual([
    ["github@openai", "  Version: 0.1.0"].join("\n"),
    ["superpowers@openai", "  Version: 5.1.0"].join("\n"),
  ])
})

test("renders namespace-aware registry skill line", () => {
  expect(
    renderAddonSkillLine(
      {
        addonName: "github",
        marketplaceName: "wanlaicode",
        registryNamespace: "alice",
      },
      { name: "triage", description: "Triage issues", content: "", location: "/skills/triage/SKILL.md" },
    ),
  ).toBe("alice/github:triage — Triage issues")
})
