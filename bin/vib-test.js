#!/usr/bin/env node
import('../dist/cli.js').then((cli) => cli.runCli(process.argv.slice(2)))
