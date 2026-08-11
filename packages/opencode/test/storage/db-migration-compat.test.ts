import { describe, expect, test } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const packageRoot = path.join(import.meta.dirname, "../..")
const goalMigration = "20260608120000_add_session_goal"
const messageSequenceMigration = "20260722145014_message_sequence"

async function openStorageDb(dbPath: string) {
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "--conditions=browser",
      "-e",
      'const { Database } = await import("./src/storage/db.ts"); Database.Client(); Database.close();',
    ],
    cwd: packageRoot,
    env: { ...process.env, WANLAICODE_DB: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code === 0) return
  throw new Error([`storage db process exited with ${code}`, stdout, stderr].join("\n"))
}

describe("database migration compatibility", () => {
  test("skips renamed session goal migration when goal column already exists", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "wanlaicode.db")

    await openStorageDb(dbPath)

    const first = new Sqlite(dbPath)
    expect(first.query("SELECT name FROM pragma_table_info('session') WHERE name = 'goal'").get()).toEqual({
      name: "goal",
    })
    first.query("DELETE FROM __drizzle_migrations WHERE name = ?").run(goalMigration)
    expect(first.query("SELECT name FROM __drizzle_migrations WHERE name = ?").get(goalMigration)).toBeNull()
    first.close()

    await openStorageDb(dbPath)

    const second = new Sqlite(dbPath)
    expect(second.query("SELECT name FROM __drizzle_migrations WHERE name = ?").get(goalMigration)).toEqual({
      name: goalMigration,
    })
    second.close()
  })

  test("backfills message sequence without deleting existing parts", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "wanlaicode.db")

    await openStorageDb(dbPath)

    const first = new Sqlite(dbPath)
    first.exec("PRAGMA foreign_keys = OFF")
    // 构造升级前的 message 表；保留 part 外键，才能覆盖事务内重建父表会级联丢数据的真实风险。
    first.exec(`
      CREATE TABLE __legacy_message (
        id text PRIMARY KEY,
        session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
      DROP TABLE message;
      ALTER TABLE __legacy_message RENAME TO message;
      CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
      DELETE FROM __drizzle_migrations WHERE name = '${messageSequenceMigration}';
    `)
    first.exec("PRAGMA foreign_keys = ON")
    first.query(
      "INSERT INTO project(id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("project-sequence", "/tmp/project-sequence", "git", 1, 1, "[]")
    first.query(
      "INSERT INTO session(id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("session-sequence", "project-sequence", "sequence", "/tmp/project-sequence", "Sequence", "1", 1, 1)
    // ID 与首次写入顺序故意相反且时间相同，确保迁移不会退回按 ID/时间排序。
    first.query(
      "INSERT INTO message(id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run("message-z", "session-sequence", 1, 1, JSON.stringify({ role: "user" }))
    first.query(
      "INSERT INTO message(id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run("message-a", "session-sequence", 1, 1, JSON.stringify({ role: "assistant" }))
    first.query(
      "INSERT INTO part(id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("part-z", "message-z", "session-sequence", 1, 1, JSON.stringify({ type: "text", text: "first" }))
    first.close()

    await openStorageDb(dbPath)

    const second = new Sqlite(dbPath)
    expect(
      second.query("SELECT id, sequence FROM message WHERE session_id = ? ORDER BY sequence").all("session-sequence"),
    ).toEqual([
      { id: "message-z", sequence: 0 },
      { id: "message-a", sequence: 1 },
    ])
    expect(second.query("SELECT id, message_id FROM part WHERE session_id = ?").all("session-sequence")).toEqual([
      { id: "part-z", message_id: "message-z" },
    ])
    expect(second.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(second.query("SELECT name FROM __drizzle_migrations WHERE name = ?").get(messageSequenceMigration)).toEqual({
      name: messageSequenceMigration,
    })
    second.close()
  })

})
