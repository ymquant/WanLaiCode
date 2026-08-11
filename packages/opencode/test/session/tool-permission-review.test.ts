import { expect, test } from "bun:test"

import { applyToolPermissionReview, mergeToolMetadata } from "@/session/tool-permission-review"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"

const running = {
  id: PartID.make("part_test"),
  messageID: MessageID.make("msg_test"),
  sessionID: SessionID.make("session_test"),
  type: "tool",
  tool: "bash",
  callID: "call_test",
  state: {
    status: "running",
    input: { command: "ls" },
    metadata: { command: "ls" },
    time: { start: 1 },
  },
} satisfies MessageV2.ToolPart

test("stores an in-progress auto-review on the running tool part", () => {
  const part = applyToolPermissionReview(running, { status: "reviewing" })

  expect(part.state).toMatchObject({
    status: "running",
    metadata: {
      command: "ls",
      permissionReview: { status: "reviewing" },
    },
  })
})

test("stores the terminal auto-review on the running tool part", () => {
  const part = applyToolPermissionReview(running, {
    status: "approved",
    decision: "approve",
    risk: "low",
    reason: "explicitly authorized",
    providerID: "wanlaicode",
    modelID: "deepseek-v4-flash",
  })

  expect(part.state).toMatchObject({
    status: "running",
    metadata: {
      command: "ls",
      permissionReview: {
        status: "approved",
        decision: "approve",
        reason: "explicitly authorized",
      },
    },
  })
})

test("preserves the auto-review when final tool metadata replaces running metadata", () => {
  expect(
    mergeToolMetadata(
      {
        command: "ls",
        permissionReview: { status: "failed", reason: "reviewer_unavailable" },
      },
      { output: "done" },
    ),
  ).toEqual({
    output: "done",
    permissionReview: { status: "failed", reason: "reviewer_unavailable" },
  })
})
