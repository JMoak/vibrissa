import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { analyzeCommits } from '@semantic-release/commit-analyzer'
import getLastRelease from 'semantic-release/lib/get-last-release.js'
import getNextVersion from 'semantic-release/lib/get-next-version.js'
import {
  ALPHA_VERSION,
  BASE_SHA,
  PACKAGE,
  TAG,
  VERSION,
  baselineReady,
  bootstrap,
  ensureMetadata,
  jsonRequest,
  waitForLatestTag,
  waitForPublication,
} from './release.mjs'

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const published = (sha = SHA) => ({ name: PACKAGE, version: VERSION, gitHead: sha })

function fixture({ existing, tag, channels, release, visibleAfter = 0 } = {}) {
  const state = { published: existing, tag, channels, release, writes: [], publishes: 0, reads: 0 }
  const metadata = () => ({
    'dist-tags': { latest: state.published ? VERSION : '0.1.0', alpha: ALPHA_VERSION },
    versions: {
      '0.1.0': { gitHead: BASE_SHA },
      [ALPHA_VERSION]: { name: PACKAGE, version: ALPHA_VERSION, gitHead: OTHER_SHA },
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
  assert.deepEqual(f.state.channels, [null])
  assert.equal(f.state.release.prerelease, false)
  assert.equal(f.state.release.make_latest, 'true')
  assert.equal((await f.registry())['dist-tags'].alpha, ALPHA_VERSION)
  assert.ok(f.state.writes.every(({ body }) => !body?.ref?.includes(ALPHA_VERSION)))
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
  assert.deepEqual(f.state.channels, ['next', null])
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

test('automatic release waits until real package, tag and stable channel metadata agree', async () => {
  assert.equal(await baselineReady(fixture()), false)
  assert.equal(await baselineReady(fixture({ existing: published() })), false)
  assert.equal(await baselineReady(fixture({ existing: published(), tag: SHA })), false)
  assert.equal(
    await baselineReady(fixture({ existing: published(), tag: SHA, channels: [null] })),
    false,
  )
  assert.equal(
    await baselineReady(
      fixture({
        existing: published(),
        tag: SHA,
        channels: [null],
        release: { draft: false, prerelease: false },
      }),
    ),
    true,
  )
  await assert.rejects(
    baselineReady(fixture({ existing: published(), tag: OTHER_SHA })),
    /does not match/,
  )
})

test('latest dist-tag propagation is retried; unexpected latest fails closed', async () => {
  let reads = 0
  const metadata = {
    'dist-tags': { latest: '0.1.0', alpha: ALPHA_VERSION },
    versions: { '0.1.0': { gitHead: BASE_SHA } },
  }
  await waitForLatestTag(
    async () => {
      if (++reads === 3) metadata['dist-tags'].latest = VERSION
      return metadata
    },
    async () => {},
    3,
  )
  assert.equal(reads, 3)
  metadata['dist-tags'].latest = '3.0.0'
  await assert.rejects(
    waitForLatestTag(
      async () => metadata,
      async () => {},
      2,
    ),
    /Unexpected latest version/,
  )
})

test('future stable versions remain eligible for automatic releases', async () => {
  for (const latest of ['2.0.0', '2.0.1', '2.1.0', '3.0.0', '10.0.0']) {
    const f = fixture({
      existing: published(),
      tag: SHA,
      channels: [null],
      release: { draft: false, prerelease: false },
    })
    const registry = f.registry
    f.registry = async (version) => {
      const value = await registry(version)
      if (!version) value['dist-tags'].latest = latest
      return value
    }
    assert.equal(await baselineReady(f), true, latest)
  }
})

test('automatic releases reject prerelease or pre-v2 latest versions', async () => {
  for (const latest of ['0.1.0', '1.0.0', ALPHA_VERSION, '2.1.0-beta.0', '02.0.0']) {
    const f = fixture({ existing: published() })
    const registry = f.registry
    f.registry = async (version) => {
      const value = await registry(version)
      if (!version) value['dist-tags'].latest = latest
      return value
    }
    await assert.rejects(baselineReady(f), /stable version at or above 2.0.0/)
  }
})

test('bootstrap refuses to alter a changed alpha channel or a newer stable history', async () => {
  for (const changedTag of [{ alpha: '2.0.0-alpha.1' }, { latest: '2.0.1' }]) {
    const f = fixture()
    const registry = f.registry
    f.registry = async (version) => {
      const value = await registry(version)
      if (!version) Object.assign(value['dist-tags'], changedTag)
      return value
    }
    await assert.rejects(bootstrap(f), /alpha must remain unchanged|Unexpected latest version/)
    assert.equal(f.state.publishes, 0)
    assert.deepEqual(f.state.writes, [])
  }
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

test('the actual semantic-release algorithm advances stable v2 for each release type', () => {
  const config = JSON.parse(readFileSync('.releaserc.json', 'utf8'))
  assert.deepEqual(config.branches, ['main'])
  const branch = {
    name: 'main',
    type: 'release',
    tags: [
      { version: '0.1.0', gitTag: 'v0.1.0', channels: [null] },
      { version: ALPHA_VERSION, gitTag: `v${ALPHA_VERSION}`, channels: ['alpha'] },
      { version: VERSION, gitTag: TAG, channels: [null] },
    ],
  }
  const lastRelease = getLastRelease({ branch, options: { tagFormat: config.tagFormat } })
  assert.equal(lastRelease.version, VERSION)
  for (const [type, expected] of [
    ['patch', '2.0.1'],
    ['minor', '2.1.0'],
    ['major', '3.0.0'],
  ]) {
    assert.equal(
      getNextVersion({ branch, lastRelease, nextRelease: { type }, logger: { log() {} } }),
      expected,
    )
  }
})
