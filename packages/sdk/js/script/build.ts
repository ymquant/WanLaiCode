#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const openapiSource = process.env.OPENCODE_SDK_OPENAPI === "hono" ? "hono" : "httpapi"
const opencode = path.resolve(dir, "../../opencode")

// `bun dev generate` now derives the spec from the Effect HttpApi contract by
// default; pass `--hono` to fall back to the legacy Hono spec for parity diffs.
if (openapiSource === "httpapi") {
  await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)
} else {
  await $`bun dev generate --hono > ${dir}/openapi.json`.cwd(opencode)
}

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

const paramsGen = path.join(dir, "src/v2/gen/core/params.gen.ts")
await $`bun prettier --write ${paramsGen}`

const paramsSource = (await Bun.file(paramsGen).text()).replace(/\r\n/g, "\n")
if (!paramsSource.includes("let bodyMapped = false")) {
  const patched = paramsSource
    .replace(
      "const stripEmptySlots = (params: Params) => {",
      "const stripEmptySlots = (params: Params, bodyMapped: boolean) => {",
    )
    .replace(
      `  for (const [slot, value] of Object.entries(params)) {
    if (value && typeof value === "object" && !Object.keys(value).length) {`,
      `  for (const [slot, value] of Object.entries(params)) {
    if (slot === "body" && bodyMapped) continue
    if (value && typeof value === "object" && !Object.keys(value).length) {`,
    )
    .replace(
      "  let config: FieldsConfig[number] | undefined\n\n  for",
      "  let config: FieldsConfig[number] | undefined\n  let bodyMapped = false\n\n  for",
    )
    .replace("        params.body = arg\n      }", "        params.body = arg\n        bodyMapped = true\n      }")
    .replace(
      "          } else {\n            params[field.map] = value\n          }",
      "          } else {\n            if (field.map === \"body\") bodyMapped = true\n            params[field.map] = value\n          }",
    )
    .replace("  stripEmptySlots(params)", "  stripEmptySlots(params, bodyMapped)")

  if (!patched.includes("let bodyMapped = false") || !patched.includes("bodyMapped) continue")) {
    throw new Error("Failed to patch params.gen.ts for empty mapped request bodies")
  }

  await Bun.write(paramsGen, patched)
}

await Bun.write(
  path.join(dir, "src/v2/gen/core/params.gen.test.ts"),
  await Bun.file(path.join(dir, "script/params.gen.test.ts")).text(),
)

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
