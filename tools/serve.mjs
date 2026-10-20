import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { serve } from 'srvx'
import { staticMiddleware } from 'srvx/static'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = pathToFileURL(path.join(root, 'dist/server/server.js')).href
const { default: handler } = await import(serverEntry)

export const server = serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? '0.0.0.0',
  middleware: [staticMiddleware({ dir: path.join(root, 'dist/client') })],
  fetch: handler.fetch,
})

await server.ready()
