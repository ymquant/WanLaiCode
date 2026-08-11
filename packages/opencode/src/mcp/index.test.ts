import { describe, expect, test } from "bun:test"
import { mergeMcpConfig } from "./index"

describe("mergeMcpConfig", () => {
  test("addon servers are last-wins before user mcp overrides", () => {
    expect(
      mergeMcpConfig(
        [
          {
            root: "/a",
            manifest: { name: "a", paths: {} },
            addonId: { addonName: "a", marketplaceName: "local" },
            mcpServers: {
              shared: { type: "local", command: ["a"] },
            },
          },
          {
            root: "/b",
            manifest: { name: "b", paths: {} },
            addonId: { addonName: "b", marketplaceName: "local" },
            mcpServers: {
              shared: { type: "local", command: ["b"] },
            },
          },
        ],
        {},
      ),
    ).toEqual({
      shared: { type: "local", command: ["b"] },
    })
  })

  test("user mcp config overrides addon server with the same name", () => {
    expect(
      mergeMcpConfig(
        [
          {
            root: "/a",
            manifest: { name: "a", paths: {} },
            addonId: { addonName: "a", marketplaceName: "local" },
            mcpServers: {
              shared: { type: "local", command: ["addon"] },
            },
          },
        ],
        {
          shared: { type: "local", command: ["user"] },
        },
      ),
    ).toEqual({
      shared: { type: "local", command: ["user"] },
    })
  })

  test("disabled addon servers are retained", () => {
    expect(
      mergeMcpConfig(
        [
          {
            root: "/a",
            manifest: { name: "a", paths: {} },
            addonId: { addonName: "a", marketplaceName: "local" },
            mcpServers: {
              disabled: { type: "local", command: ["node"], enabled: false },
            },
          },
        ],
        {},
      ),
    ).toEqual({
      disabled: { type: "local", command: ["node"], enabled: false },
    })
  })
})
