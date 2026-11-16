#!/usr/bin/env node
/**
 * Build index.json for the DSH plugin market.
 *
 * Sources:
 * - npm packages maintained by the configured npm users, discovered through the registry search API;
 * - explicit package names in `discovery.include`;
 * - display overrides and market declarations in `plugins.json`.
 *
 * Only published versions that declare `dsh.bundle` and a valid `engines.dsh` range are listed. Versions without
 * both are reported and skipped: DSH rejects the whole index when any listed version violates that rule.
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { relative } from 'node:path'
import hostedGitInfo from 'hosted-git-info'
import semver from 'semver'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

const ROOT = new URL('../', import.meta.url)
const CONFIG_FILE = new URL('plugins.json', ROOT)
const OUTPUT_FILE = new URL('index.json', ROOT)
const DEFAULT_INDEX_URL = 'https://raw.githubusercontent.com/cnzgray/dsh-plugins/main/index.json'
const INDEX_URL = process.env.INDEX_URL ?? DEFAULT_INDEX_URL
const REGISTRY = 'https://registry.npmjs.org/'
const USER_AGENT = 'dsh-plugins-index (+https://github.com/cnzgray/dsh-plugins)'
const SEARCH_PAGE_SIZE = 250
const MAX_SEARCH_RESULTS = 1000

const warnings = []

/** Record a non-fatal diagnostic. */
function warn(message) {
  warnings.push(message)
  console.error(`warning: ${message}`)
}

/** A non-blank string, or undefined. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Fetch a JSON document with bounded retries for rate limits and transient server errors. */
async function getJson(input, { headers = {}, timeoutMs = 30_000 } = {}) {
  const url = input.toString()
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        const error = new Error(`${url}: HTTP ${response.status}`)
        error.status = response.status
        if (response.status !== 429 && response.status < 500) throw error
        lastError = error
      } else {
        return await response.json()
      }
    } catch (error) {
      if (error?.status !== undefined && error.status !== 429 && error.status < 500) throw error
      lastError = error
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1_000))
  }
  throw lastError
}

/** npm package names published by the configured maintainers, plus explicit includes. */
async function discoverNames(discovery) {
  const names = new Set(Array.isArray(discovery?.include) ? discovery.include.filter(name => typeof name === 'string') : [])
  for (const maintainer of Array.isArray(discovery?.maintainers) ? discovery.maintainers : []) {
    let from = 0
    for (;;) {
      const url = new URL('-/v1/search', REGISTRY)
      url.searchParams.set('text', `maintainer:${maintainer}`)
      url.searchParams.set('size', String(SEARCH_PAGE_SIZE))
      url.searchParams.set('from', String(from))
      const body = await getJson(url)
      const objects = Array.isArray(body.objects) ? body.objects : []
      for (const object of objects) {
        const name = object?.package?.name
        if (typeof name === 'string' && name.trim() !== '') names.add(name)
      }
      from += objects.length
      const total = Number.isInteger(body.total) ? body.total : from
      if (objects.length === 0 || from >= total) break
      if (from >= MAX_SEARCH_RESULTS) {
        warn(`npm search for maintainer ${maintainer} has more than ${MAX_SEARCH_RESULTS} results; the rest is ignored`)
        break
      }
    }
  }
  return names
}

/** The full npm registry document of one package. */
async function readPackument(name) {
  return await getJson(`${REGISTRY}${name.replace('/', '%2f')}`, {
    headers: { accept: 'application/json' },
  })
}

/** Whether a manifest declares a DSH bundle. */
function isBundle(manifest) {
  return Boolean(manifest && typeof manifest === 'object' && manifest.dsh && manifest.dsh.bundle)
}

/** The npm author name without contact details. */
function authorName(author) {
  const raw = typeof author === 'string' ? author : author && typeof author === 'object' ? author.name : undefined
  if (typeof raw !== 'string') return undefined
  const name = raw.replace(/<[^>]*>|\([^)]*\)/gu, '').trim()
  return name === '' ? undefined : name
}

/** An absolute http(s) URL, or undefined. */
function httpUrl(value) {
  const declared = text(value)
  if (declared === undefined || !URL.canParse(declared)) return undefined
  const url = new URL(declared)
  return url.protocol === 'https:' || url.protocol === 'http:' ? declared : undefined
}

/** The repository's web URL and optional package directory, normalized from package.json `repository`. */
function repositoryOf(value) {
  const declared = typeof value === 'string' ? value : text(value?.url)
  if (declared === undefined) return undefined
  let url
  try {
    url = hostedGitInfo.fromUrl(declared.replace(/#.*$/u, ''))?.browse()
  } catch {
    // A shorthand hosted-git-info cannot parse falls through to the plain URL path.
  }
  if (url === undefined) {
    const plain = declared.replace(/^git\+/u, '')
    if (!URL.canParse(plain)) return undefined
    const parsed = new URL(plain)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    parsed.pathname = parsed.pathname.replace(/\.git$/u, '')
    url = parsed.href
  }
  url = url.replace(/#.*$/u, '')
  const declaredDirectory = typeof value === 'object' ? text(value.directory)?.replace(/^\.\/|\/$/gu, '') : undefined
  const validDirectory = declaredDirectory !== undefined
    && declaredDirectory.split('/').every(segment => segment !== '.' && segment !== '..' && /^[A-Za-z0-9._@+-]+$/u.test(segment))
  return { url, ...(validDirectory ? { directory: declaredDirectory } : {}) }
}

/** The listed versions of one package, newest first. */
function eligibleVersions(name, packument) {
  const releases = []
  for (const [version, manifest] of Object.entries(packument.versions ?? {})) {
    if (!manifest || typeof manifest !== 'object') continue
    if (manifest.name !== name) {
      warn(`${name}@${version} skipped: the registry manifest names ${JSON.stringify(manifest.name)}`)
      continue
    }
    if (manifest.private === true) continue
    if (typeof manifest.deprecated === 'string' ? manifest.deprecated.trim() !== '' : manifest.deprecated === true) continue
    if (!isBundle(manifest)) continue
    const published = packument.time?.[version]
    if (typeof published !== 'string') {
      warn(`${name}@${version} skipped: npm has no publish time`)
      continue
    }
    const publishTimestamp = Math.floor(Date.parse(published) / 1_000)
    if (!Number.isFinite(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= 1e11) {
      warn(`${name}@${version} skipped: invalid publish time ${JSON.stringify(published)}`)
      continue
    }
    if (semver.valid(version) !== version) {
      warn(`${name}@${version} skipped: not a canonical npm version`)
      continue
    }
    const dsh = manifest.engines?.dsh
    if (typeof dsh !== 'string' || dsh.trim() === '') {
      warn(`${name}@${version} skipped: package.json engines.dsh is missing`)
      continue
    }
    if (semver.validRange(dsh, { includePrerelease: true }) === null) {
      warn(`${name}@${version} skipped: engines.dsh is not a valid semver range: ${JSON.stringify(dsh)}`)
      continue
    }
    releases.push({ version, manifest, publishTimestamp, dsh })
  }
  return releases.sort((left, right) => semver.rcompare(left.version, right.version))
}

/** One validated market plugin entry, with display metadata from the package manifest and config overrides. */
function entryOf(name, releases, config) {
  const highest = releases[0]
  const manifest = highest.manifest
  const override = config.packages?.[name] ?? {}
  const description = override.description ?? text(manifest.description)
  const author = authorName(manifest.author)
  const homepage = httpUrl(manifest.homepage)
  const repository = repositoryOf(manifest.repository)
  const keywords = Array.isArray(manifest.keywords) && manifest.keywords.every(keyword => typeof keyword === 'string')
    ? manifest.keywords
    : undefined
  const metadata = {
    ...(override.category === undefined ? {} : { category: override.category }),
    ...(keywords === undefined ? {} : { keywords }),
    ...(override.labels === undefined ? {} : { labels: override.labels }),
  }
  return {
    name,
    ...(override.title === undefined ? {} : { title: override.title }),
    ...(description === undefined ? {} : { description }),
    ...(override.icon === undefined ? {} : { icon: override.icon }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(repository === undefined ? {} : { repository }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    versions: releases.map(release => ({
      version: release.version,
      publishTimestamp: release.publishTimestamp,
      source: { type: 'npm' },
      engines: { dsh: release.dsh },
    })),
  }
}

/** Read all configured and discovered packages, in config order followed by npm order. */
async function readPlugins(config) {
  const configured = Object.keys(config.packages ?? {})
  const configuredSet = new Set(configured)
  const discovered = await discoverNames(config.discovery ?? {})
  const names = [
    ...configured,
    ...[...discovered].filter(name => !configuredSet.has(name)).sort(),
  ]
  const plugins = []
  for (const name of names) {
    let packument
    try {
      packument = await readPackument(name)
    } catch (error) {
      if (error?.status === 404) {
        warn(`${name} skipped: not found on npm`)
        continue
      }
      throw new Error(`${name}: cannot read npm metadata: ${error.message}`)
    }
    const releases = eligibleVersions(name, packument)
    if (releases.length === 0) {
      if (configuredSet.has(name) && !Object.values(packument.versions ?? {}).some(isBundle)) {
        warn(`${name} skipped: no published version declares dsh.bundle`)
      }
      continue
    }
    plugins.push(entryOf(name, releases, config))
  }
  return plugins
}

/** Write the GitHub Actions run summary when the workflow asks for one. */
async function writeSummary(plugins, changed) {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (path === undefined || path === '') return
  const versions = plugins.reduce((count, plugin) => count + plugin.versions.length, 0)
  const lines = [
    '## DSH plugin index',
    '',
    `- Plugins: ${plugins.length}`,
    `- Versions: ${versions}`,
    `- index.json: ${changed ? 'updated' : 'unchanged'}`,
    ...(warnings.length === 0 ? [] : ['', '### Warnings', ...warnings.map(warning => `- ${warning}`)]),
  ]
  await appendFile(path, `${lines.join('\n')}\n`)
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
  if (config?.title === undefined) throw new Error('plugins.json must declare a title')
  const plugins = await readPlugins(config)
  if (plugins.length === 0) {
    throw new Error('no eligible plugins found; refusing to replace index.json with an empty index')
  }
  const index = {
    format: 1,
    title: config.title,
    ...(config.description === undefined ? {} : { description: config.description }),
    metadata: {
      categories: config.categories ?? {},
      labels: config.labels ?? {},
      ...(config.sortKeys === undefined ? {} : { sortKeys: config.sortKeys }),
    },
    plugins,
  }
  for (const plugin of plugins) {
    for (const version of plugin.versions) {
      if (typeof version.engines?.dsh !== 'string' || version.engines.dsh.trim() === '') {
        throw new Error(`${plugin.name}@${version.version}: generated version has no engines.dsh`)
      }
    }
  }
  try {
    parseMarketIndex(index, INDEX_URL)
  } catch (error) {
    throw new Error(`generated index does not validate: ${error.message}`)
  }
  const serialized = `${JSON.stringify(index, null, 2)}\n`
  let previous
  try {
    previous = await readFile(OUTPUT_FILE, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const changed = previous !== serialized
  if (changed) await writeFile(OUTPUT_FILE, serialized)
  await writeSummary(plugins, changed)
  const versions = plugins.reduce((count, plugin) => count + plugin.versions.length, 0)
  console.log(`${changed ? 'wrote' : 'unchanged'} ${relative(process.cwd(), fileURLToPath(OUTPUT_FILE))}: ${plugins.length} plugin(s), ${versions} version(s)`)
}

main().catch(error => {
  console.error(`error: ${error.message}`)
  process.exitCode = 1
})
