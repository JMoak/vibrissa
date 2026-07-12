import { parseArgValue, parseEnvPairs, parseToolArgs, splitCommandLine } from '../src/cli/args'

describe('cli args helpers', () => {
  it('splits quoted server command lines', () => {
    expect(splitCommandLine('node dist/index.js')).toEqual({
      cmd: 'node',
      args: ['dist/index.js'],
    })
    expect(splitCommandLine('node "path with spaces/server.js" --flag')).toEqual({
      cmd: 'node',
      args: ['path with spaces/server.js', '--flag'],
    })
  })

  it('parses env pairs', () => {
    expect(parseEnvPairs(['FOO=bar', 'A=b=c'])).toEqual({ FOO: 'bar', A: 'b=c' })
    expect(() => parseEnvPairs(['NOVALUE'])).toThrow(/KEY=VALUE/)
  })

  it('parses tool args from JSON and key=value pairs', () => {
    expect(
      parseToolArgs(['--args', '{"text":"hi"}', '--arg', 'uppercase=true', '--arg', 'n=2']),
    ).toEqual({ text: 'hi', uppercase: true, n: 2 })
    expect(parseArgValue('null')).toBeNull()
    expect(parseArgValue('[1,2]')).toEqual([1, 2])
  })
})
