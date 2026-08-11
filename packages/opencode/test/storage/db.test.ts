import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { Database } from "@/storage/db"

describe("Database.Path", () => {
  test("uses one local database for all non-release channels", () => {
    const expected = ["latest", "beta", "prod"].includes(InstallationChannel)
      ? path.join(Global.Path.data, "wanlaicode.db")
      : path.join(Global.Path.data, "wanlaicode-local.db")
    expect(Database.getChannelPath()).toBe(expected)
  })
})
