import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const PACKAGE = '@jmoak/vibrissa'
export const VERSION = '2.0.0'
export const ALPHA_VERSION = '2.0.0-alpha.0'
export const TAG = `v${VERSION}`
export const BASE_SHA = '6367edc8d0095904739bc0cce699796716d23855'
const NOTE_REF = `notes/semantic-release-${TAG}`
const REPO = 'JMoak/vibrissa'
const IDENTITY = { name: 'Jordan Moak', email: 'jordan.moak@gmail.com' }

// A missing version is distinct from a registry outage or an authentication error.
export async function jsonRequest(url, options = {}, fetcher = fetch) {
  const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(30000) })
  if (response.status === 404 && (!options.method || options.method === 'GET')) return null
  if (!response.ok) throw new Error(`Request failed: HTTP ${response.status} at ${url}`)
  return response.json()
}

export function clients(token) {
  return {
    registry: (version = '') =>
      jsonRequest(
        `https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}${version ? `/${version}` : ''}`,
      ),
    github: (path, method = 'GET', body = undefined) =>
      jsonRequest(`https://api.github.com/repos/${REPO}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
  }
}

export function verifyPublished(published, sha) {
  assert.equal(published?.name, PACKAGE, 'Registry package name does not match')
  assert.equal(published?.version, VERSION, 'Registry version does not match')
  assert.match(published?.gitHead ?? '', /^[a-f0-9]{40}$/, 'Registry gitHead is missing')
  if (sha)
    assert.equal(
      published.gitHead,
      sha,
      'This version was published from a different commit. Rerun the original bootstrap workflow run to repair its metadata.',
    )
}

export function verifyInitialRegistry(metadata) {
  assert.ok(
    ['0.1.0', VERSION].includes(metadata?.['dist-tags']?.latest),
    'Unexpected latest version; stable bootstrap only permits 0.1.0 or 2.0.0',
  )
  assert.equal(
    metadata['dist-tags'].alpha,
    ALPHA_VERSION,
    'The published alpha must remain unchanged',
  )
  assert.ok(
    Object.keys(metadata.versions ?? {}).every((version) =>
      ['0.1.0', ALPHA_VERSION, VERSION].includes(version),
    ),
    'Unexpected published versions; review the release history before bootstrapping',
  )
  assert.equal(metadata.versions?.['0.1.0']?.gitHead, BASE_SHA, 'The stable baseline has changed')
}

async function noteState(github, sha) {
  const ref = await github(`git/ref/${NOTE_REF}`)
  if (!ref) return { channels: [] }
  const commit = await github(`git/commits/${ref.object.sha}`)
  const tree = await github(`git/trees/${commit.tree.sha}?recursive=1`)
  assert.ok(!tree.truncated, 'Cannot inspect a truncated notes tree')
  const entry = tree.tree.find(
    (item) => item.type === 'blob' && item.path.replaceAll('/', '') === sha,
  )
  if (!entry) return { ref, commit, channels: [] }
  const blob = await github(`git/blobs/${entry.sha}`)
  const note = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'))
  assert.ok(Array.isArray(note.channels), 'Existing release note has invalid channel metadata')
  return { ref, commit, entry, channels: note.channels }
}

export async function baselineReady({ registry, github }) {
  const published = await registry(VERSION)
  if (!published) return false
  verifyPublished(published)
  const metadata = await registry()
  const latest = metadata?.['dist-tags']?.latest
  assert.ok(
    typeof latest === 'string' &&
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(latest) &&
      Number(latest.split('.')[0]) >= 2,
    'latest must identify a stable version at or above 2.0.0',
  )
  const tag = await github(`git/ref/tags/${TAG}`)
  if (!tag) return false
  assert.equal(tag.object.type, 'commit', 'The stable baseline must be a lightweight tag')
  assert.equal(
    tag.object.sha,
    published.gitHead,
    'The stable tag does not match the published commit',
  )
  if (!(await noteState(github, published.gitHead)).channels.includes(null)) return false
  const release = await github(`releases/tags/${TAG}`)
  return release?.draft === false && release?.prerelease === false
}

export async function waitForPublication(
  registry,
  sha,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 30,
) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    let published
    try {
      published = await registry(VERSION)
    } catch (error) {
      lastError = error
    }
    if (published) {
      verifyPublished(published, sha)
      return published
    }
    if (attempt + 1 < attempts) await sleep(10000)
  }
  throw new Error(
    'Published version is not yet verifiable. Rerun bootstrap to repair metadata; no tag was created.',
    { cause: lastError },
  )
}

export async function ensureMetadata(github, sha, notes) {
  const tag = await github(`git/ref/tags/${TAG}`)
  if (tag) {
    assert.equal(tag.object.type, 'commit', 'Existing stable tag is not a lightweight tag')
    assert.equal(tag.object.sha, sha, 'Existing stable tag points to a different commit')
  } else {
    await github('git/refs', 'POST', { ref: `refs/tags/${TAG}`, sha })
  }
  const state = await noteState(github, sha)
  if (!state.channels.includes(null)) {
    const blob = await github('git/blobs', 'POST', {
      content: JSON.stringify({ channels: [...state.channels, null] }),
      encoding: 'utf-8',
    })
    const tree = await github('git/trees', 'POST', {
      ...(state.commit ? { base_tree: state.commit.tree.sha } : {}),
      tree: [{ path: state.entry?.path ?? sha, mode: '100644', type: 'blob', sha: blob.sha }],
    })
    const commit = await github('git/commits', 'POST', {
      message: `Record stable release channel for ${TAG}`,
      tree: tree.sha,
      parents: state.ref ? [state.ref.object.sha] : [],
      author: IDENTITY,
      committer: IDENTITY,
    })
    if (state.ref) {
      await github(`git/refs/${NOTE_REF}`, 'PATCH', { sha: commit.sha, force: false })
    } else {
      await github('git/refs', 'POST', { ref: `refs/${NOTE_REF}`, sha: commit.sha })
    }
  }
  const release = await github(`releases/tags/${TAG}`)
  if (release) {
    assert.equal(release.draft, false, 'Existing release is still a draft')
    assert.equal(release.prerelease, false, 'Existing release must be stable')
  } else {
    await github('releases', 'POST', {
      tag_name: TAG,
      target_commitish: sha,
      name: TAG,
      body: notes,
      draft: false,
      prerelease: false,
      make_latest: 'true',
    })
  }
}

export async function waitForLatestTag(
  registry,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 30,
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const metadata = await registry()
    verifyInitialRegistry(metadata)
    if (metadata['dist-tags'].latest === VERSION) return
    if (attempt + 1 < attempts) await sleep(10000)
  }
  throw new Error(
    'Latest dist-tag is not visible yet. Rerun the original bootstrap workflow run to repair metadata.',
  )
}

export async function bootstrap({ registry, github, publish, sha, notes, sleep }) {
  verifyInitialRegistry(await registry())
  const stableTag = await github('git/ref/tags/v0.1.0')
  assert.equal(stableTag?.object.sha, BASE_SHA, 'v0.1.0 must anchor the actual 0.1.0 release')
  const existingTag = await github(`git/ref/tags/${TAG}`)
  if (existingTag)
    assert.equal(existingTag.object.sha, sha, 'Existing stable tag points to another commit')
  const existing = await registry(VERSION)
  if (existing) verifyPublished(existing, sha)
  else {
    const main = await github('git/ref/heads/main')
    assert.equal(main?.object.sha, sha, 'main advanced; dispatch bootstrap again from current main')
    await publish()
  }
  await waitForPublication(registry, sha, sleep)
  await waitForLatestTag(registry, sleep)
  // A release tag must never claim a version before npm confirms its actual gitHead.
  await ensureMetadata(github, sha, notes)
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Release commands run only in GitHub Actions')
  assert.equal(process.env.GITHUB_REPOSITORY, REPO, 'Unexpected repository')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Release commands require main')
  assert.equal(
    process.env.GITHUB_WORKFLOW_REF,
    `${REPO}/.github/workflows/release.yml@refs/heads/main`,
    'Unexpected trusted-publisher workflow',
  )
  assert.ok(process.env.GITHUB_TOKEN, 'GITHUB_TOKEN is required')
  const api = clients(process.env.GITHUB_TOKEN)
  if (process.argv[2] === 'check') {
    const ready = await baselineReady(api)
    appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\n`)
    if (!ready) {
      const message =
        'Automatic stable publishing is waiting for the one-time 2.0.0 bootstrap. Run Release on main with bootstrapStable enabled. If publication already happened, rerun the original bootstrap workflow run to repair interrupted metadata writes.'
      console.log(`::notice::${message}`)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`)
    }
    return
  }
  assert.equal(process.argv[2], 'bootstrap', 'Expected check or bootstrap')
  assert.equal(
    process.env.GITHUB_EVENT_NAME,
    'workflow_dispatch',
    'Bootstrap requires a manual dispatch',
  )
  assert.equal(process.env.BOOTSTRAP_STABLE, 'true', 'Bootstrap must be explicitly selected')
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.equal(sha, process.env.GITHUB_SHA, 'Checkout does not match the tested workflow commit')
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    '',
    'Bootstrap requires a clean checkout',
  )
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.equal(manifest.name, PACKAGE)
  assert.equal(manifest.version, VERSION, 'Bootstrap only publishes 2.0.0')
  await bootstrap({
    ...api,
    sha,
    notes: readFileSync('docs/RELEASE_V2.md', 'utf8'),
    publish: () => execFileSync('npm', ['publish', '--tag', 'latest'], { stdio: 'inherit' }),
  })
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `Published and recorded ${PACKAGE}@${VERSION} on latest. The alpha channel remains 2.0.0-alpha.0.\n`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
