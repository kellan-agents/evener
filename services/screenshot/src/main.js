import http from 'node:http'
import { loadConfig } from './config.js'
import { createCore } from './core.js'
import { createApp } from './server.js'

try {
  const config = loadConfig(process.env)
  const core = createCore()
  await core.start()
  const server = http.createServer(createApp({ config, core }))
  server.listen(config.port)
  console.log(`websnap listening on port ${config.port}`)

  let shuttingDown = false
  function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    server.closeAllConnections()
    server.close(() => {
      core.stop().finally(() => process.exit(0))
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
} catch (err) {
  console.error(String(err?.message ?? err))
  process.exit(1)
}
