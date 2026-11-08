import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { analyzeCommits } from '@semantic-release/commit-analyzer'
import getLastRelease from 'semantic-release/lib/get-last-release.js'
import getNextVersion from 'semantic-release/lib/get-next-version.js'
import {
  BASE_SHA,
  PACKAGE,
  TAG,
  VERSION,
  baselineReady,
  bootstrap,
  ensureMetadata,
  jsonRequest,
  waitForAlphaTag,
  waitForPublication,
} from './release.mjs'

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const published = (sha = SHA) => ({ name: PACKAGE, version: VERSION, gitHead: sha })

function fixture({ existing, tag, channels, release, visibleAfter = 0 } = {}) {
  const state = { published: existing, tag, channels, release, writes: [], publishes: 0, reads: 0 }
  const metadata = () => ({
    'dist-tags': { latest: '0.1.0', ...(state.published ? { alpha: VERSION } : {}) },
    versions: {
      '0.1.0': { gitHead: BASE_SHA },
      ...(state.published ? { [VERSION]: state.published } : {}),
    },
  })
  const registry = async (version) => {
    if (!version) return metadata()
    state.reads++
    return state.reads <= visibleAfter ? null : state.published
  }
  const github = async (path, method = 'GET', body = undefined) => {
    if (method !== 'GET') {
      state.writes.push({ path, method, body })
      assert.ok(state.published, 'Git metadata must never precede the real publication')
      if (path === 'git/refs' && body.ref === `refs/tags/${TAG}`) state.tag = body.sha
      if (path === 'git/blobs') state.channels = JSON.parse(body.content).channels
      if (path === 'releases') state.release = body
      return { sha: 'created-object' }
    }
    if (path === 'git/ref/heads/main') return { object: { sha: SHA, type: 'commit' } }
    if (['git/ref/heads/stable', 'git/ref/tags/v0.1.0'].includes(path))
      return { object: { sha: BASE_SHA } }
    if (path === `git/ref/tags/${TAG}`)
      return state.tag ? { object: { sha: state.tag, type: 'commit' } } : null
    if (path === `git/ref/notes/semantic-release-${TAG}`)
      return channels ? { object: { sha: 'note-commit' } } : null
    if (path === 'git/commits/note-commit') return { tree: { sha: 'note-tree' } }
    if (path === 'git/trees/note-tree?recursive=1')
      return {
        tree: [{ type: 'blob', path: `${SHA.slice(0, 2)}/${SHA.slice(2)}`, sha: 'note-blob' }],
      }
    if (path === 'git/blobs/note-blob')
      return {
        content: Buffer.from(JSON.stringify({ channels: state.channels })).toString('base64'),
      }
    if (path === `releases/tags/${TAG}`) return state.release ?? null
    throw new Error(`Unexpected request: ${path}`)
  }
  return {
    state,
    registry,
    github,
    sha: SHA,
    notes: 'Release notes',
    sleep: async () => {},
    publish: async () => {
      state.publishes++
      state.published = published()
    },
  }
}

test('only HTTP 404 GET means absent; outages, auth errors and failed writes are fatal', async () => {
  assert.equal(await jsonRequest('https://example.test', {}, async () => ({ status: 404 })), null)
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      jsonRequest('https://example.test', {}, async () => ({ status })),
      new RegExp(`HTTP ${status}`),
    )
  }
  await assert.rejects(
    jsonRequest('https://example.test', { method: 'POST' }, async () => ({ status: 404 })),
    /HTTP 404/,
  )
  await assert.rejects(
    jsonRequest('https://example.test', {}, async () => {
      throw new Error('offline')
    }),
    /offline/,
  )
})

test('first publication waits for registry propagation before creating metadata', async () => {
  const f = fixture({ visibleAfter: 3 })
  await bootstrap(f)
  assert.equal(f.state.publishes, 1)
  assert.equal(f.state.tag, SHA)
  assert.deepEqual(f.state.channels, ['alpha'])
  assert.equal(f.state.release.prerelease, true)
  assert.equal(f.state.release.make_latest, 'false')
  const commit = f.state.writes.find((write) => write.path === 'git/commits').body
  assert.deepEqual(commit.author, { name: 'Jordan Moak', email: 'jordan.moak@gmail.com' })
  assert.deepEqual(commit.committer, commit.author)
})

test('same-commit publication repairs missing metadata without republishing', async () => {
  const f = fixture({ existing: published() })
  await bootstrap(f)
  assert.equal(f.state.publishes, 0)
  assert.equal(f.state.tag, SHA)
})

test('an existing version from a different commit fails before any write', async () => {
  const f = fixture({ existing: published(OTHER_SHA) })
  await assert.rejects(bootstrap(f), /different commit/)
  assert.equal(f.state.publishes, 0)
  assert.deepEqual(f.state.writes, [])
})

test('conflicting existing tags are never replaced', async () => {
  const f = fixture({ existing: published(), tag: OTHER_SHA })
  await assert.rejects(bootstrap(f), /another commit/)
  await assert.rejects(ensureMetadata(f.github, SHA, 'notes'), /different commit/)
  assert.deepEqual(f.state.writes, [])
})

test('notes preserve other channels, the fanout path, and the existing notes tree', async () => {
  const f = fixture({ existing: published(), tag: SHA, channels: ['next'] })
  await bootstrap(f)
  assert.deepEqual(f.state.channels, ['next', 'alpha'])
  const tree = f.state.writes.find((write) => write.path === 'git/trees').body
  assert.equal(tree.base_tree, 'note-tree')
  assert.equal(tree.tree[0].path, `${SHA.slice(0, 2)}/${SHA.slice(2)}`)
  const ref = f.state.writes.find((write) => write.method === 'PATCH').body
  assert.equal(ref.force, false)
})

test('stale main candidates fail before publishing', async () => {
  const f = fixture()
  const github = f.github
  f.github = (path, ...args) =>
    path === 'git/ref/heads/main' ? { object: { sha: OTHER_SHA } } : github(path, ...args)
  await assert.rejects(bootstrap(f), /main advanced/)
  assert.equal(f.state.publishes, 0)
})

test('retrying the original publication repairs metadata even after main advances', async () => {
  const f = fixture({ existing: published() })
  const github = f.github
  f.github = (path, ...args) =>
    path === 'git/ref/heads/main' ? { object: { sha: OTHER_SHA } } : github(path, ...args)
  await bootstrap(f)
  assert.equal(f.state.publishes, 0)
  assert.equal(f.state.tag, SHA)
})

test('registry failures before publication fail closed', async () => {
  const f = fixture()
  f.registry = async () => {
    throw new Error('HTTP 500')
  }
  await assert.rejects(bootstrap(f), /HTTP 500/)
  assert.equal(f.state.publishes, 0)
  assert.deepEqual(f.state.writes, [])
})

test('publication verification retries transient failures and fails if never visible', async () => {
  let reads = 0
  assert.deepEqual(
    await waitForPublication(
      async () => {
        if (++reads < 3) throw new Error('HTTP 500')
        return published()
      },
      SHA,
      async () => {},
      3,
    ),
    published(),
  )
  await assert.rejects(
    waitForPublication(
      async () => null,
      SHA,
      async () => {},
      2,
    ),
    /no tag was created/,
  )
  await assert.rejects(
    waitForPublication(
      async () => published(OTHER_SHA),
      SHA,
      async () => {},
    ),
    /different commit/,
  )
})

test('automatic release waits until real package, tag and alpha channel metadata agree', async () => {
  assert.equal(await baselineReady(fixture()), false)
  assert.equal(await baselineReady(fixture({ existing: published() })), false)
  assert.equal(await baselineReady(fixture({ existing: published(), tag: SHA })), false)
  assert.equal(
    await baselineReady(fixture({ existing: published(), tag: SHA, channels: ['alpha'] })),
    false,
  )
  assert.equal(
    await baselineReady(
      fixture({
        existing: published(),
        tag: SHA,
        channels: ['alpha'],
        release: { draft: false, prerelease: true },
      }),
    ),
    true,
  )
  await assert.rejects(
    baselineReady(fixture({ existing: published(), tag: OTHER_SHA })),
    /does not match/,
  )
})

test('alpha dist-tag propagation is retried; unexpected latest fails closed', async () => {
  let reads = 0
  const metadata = {
    'dist-tags': { latest: '0.1.0' },
    versions: { '0.1.0': { gitHead: BASE_SHA } },
  }
  await waitForAlphaTag(
    async () => {
      if (++reads === 3) metadata['dist-tags'].alpha = VERSION
      return metadata
    },
    async () => {},
    3,
  )
  assert.equal(reads, 3)
  metadata['dist-tags'].latest = VERSION
  await assert.rejects(
    waitForAlphaTag(
      async () => metadata,
      async () => {},
      2,
    ),
    /latest must stay/,
  )
})

test('conventional release commits publish; maintenance-only commits do not', async () => {
  for (const [message, expected] of [
    ['fix: repair a runtime bug', 'patch'],
    ['perf: reduce startup cost', 'patch'],
    ['feat: add a matcher', 'minor'],
    ['feat!: change the API', 'major'],
    ['chore(deps): update development dependencies', null],
    ['docs: explain alpha installs', null],
    ['test: stabilize an assertion', null],
  ]) {
    assert.equal(
      await analyzeCommits(
        { preset: 'conventionalcommits' },
        {
          cwd: process.cwd(),
          commits: [{ hash: SHA, message }],
          logger: { log() {} },
        },
      ),
      expected,
    )
  }
})

test('the actual semantic-release algorithm increments v2 alphas for all release types', () => {
  const config = JSON.parse(readFileSync('.releaserc.json', 'utf8'))
  assert.deepEqual(config.branches, [
    'stable',
    { name: 'main', prerelease: 'alpha', channel: 'alpha' },
  ])
  const branch = {
    ...config.branches[1],
    type: 'prerelease',
    tags: [
      { version: '0.1.0', gitTag: 'v0.1.0', channels: [null] },
      { version: VERSION, gitTag: TAG, channels: ['alpha'] },
    ],
  }
  const lastRelease = getLastRelease({ branch, options: { tagFormat: config.tagFormat } })
  assert.equal(lastRelease.version, VERSION)
  for (const type of ['patch', 'minor', 'major']) {
    assert.equal(
      getNextVersion({
        branch,
        lastRelease,
        nextRelease: { type, channel: 'alpha' },
        logger: { log() {} },
      }),
      '2.0.0-alpha.1',
    )
  }
})
