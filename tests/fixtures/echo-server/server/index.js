// Minimal placeholder MCP server: keep process alive
// Real MCP inspector integration will replace this
import process from 'node:process'

process.stderr.write('[echo-server] started\n')

// Keep the process alive and responsive to shutdown
process.stdin.resume()

process.on('SIGTERM', () => {
  process.stderr.write('[echo-server] received SIGTERM, exiting\n')
  process.exit(0)
})


