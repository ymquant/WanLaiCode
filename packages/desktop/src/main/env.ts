import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

export const root = dirname(fileURLToPath(import.meta.url))
