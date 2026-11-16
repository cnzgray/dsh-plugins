#!/usr/bin/env node
/** Validate index.json with the same library DSH uses to read it, plus the documented required DSH range. */
import { readFile } from 'node:fs/promises'
import semver from 'semver'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

const file = process.argv[2] ?? 'index.json'
const indexUrl = process.env.INDEX_URL ?? 'https://raw.githubusercontent.com/cnzgray/dsh-plugins/main/index.json'
const document = JSON.parse(await readFile(file, 'utf8'))
const index = parseMarketIndex(document, indexUrl)
for (const plugin of index.plugins) {
  for (const version of plugin.versions) {
    const range = version.engines?.dsh
    if (typeof range !== 'string' || range.trim() === '' || semver.validRange(range, { includePrerelease: true }) === null) {
      throw new Error(`${plugin.name}@${version.version}: engines.dsh must be a valid SemVer range`)
    }
  }
}
const versions = index.plugins.reduce((count, plugin) => count + plugin.versions.length, 0)
console.log(`valid: ${file} - ${index.plugins.length} plugin(s), ${versions} version(s)`)
