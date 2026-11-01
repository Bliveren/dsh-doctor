/**
 * Health checks for a DeepSeek Harness installation.
 *
 * Every check is a pure function over paths and process facts, so the same
 * report works in tests, in the `dsh_doctor` tool, and in a future CLI.
 * Findings never contain credential contents; paths are redacted on render.
 *
 * @module dsh-doctor/checks
 */

import { accessSync, constants, existsSync, readFileSync, readdirSync, statfsSync, statSync } from 'node:fs'
import { arch, homedir, platform } from 'node:os'
import path from 'node:path'
import semver from 'semver'
import { parse as parseYaml } from 'yaml'

/** Node.js floor taken from the repository development guide. */
const DEFAULT_NODE_FLOOR = '>=24.9'

/** Free-space warning threshold in bytes. */
const LOW_DISK_BYTES = 2 * 1024 * 1024 * 1024

/**
 * @typedef {'pass'|'warn'|'fail'|'skip'} Status
 *
 * @typedef {object} Finding
 * @property {string} id Check identity, `area/name` form.
 * @property {string} title One-line human title.
 * @property {Status} status Result of this check.
 * @property {string} detail Observed fact, redacted.
 * @property {string} [hint] Actionable next step when not passing.
 *
 * @typedef {object} Report
 * @property {string} generatedAt ISO timestamp.
 * @property {string} platform `os arch` summary.
 * @property {string} node Node.js version.
 * @property {string} dshHome DSH home directory, redacted on render.
 * @property {string|null} profile Profile name under inspection.
 * @property {Finding[]} findings Ordered check results.
 * @property {{pass:number, warn:number, fail:number, skip:number}} summary
 */

/**
 * Resolve the DSH home directory the way the launcher does.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} Absolute path to the DSH home directory.
 */
export function defaultDshHome(env = process.env) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return path.resolve(configured)
  return path.join(homedir(), '.dsh')
}

/**
 * Identify the profile the running host was launched with.
 *
 * Desktop and CLI launches pass the profile directory as an argument, so the
 * first argument under `<dshHome>/profiles/` names it. `DSH_PROFILE` covers
 * launches that do not.
 * @param {object} options
 * @param {string[]} options.argv Host process arguments.
 * @param {string} options.dshHome DSH home directory.
 * @param {NodeJS.ProcessEnv} options.env Host environment.
 * @returns {string|null} Profile name, or null when it cannot be determined.
 */
export function detectProfileName({ argv, dshHome, env }) {
  const prefix = path.join(dshHome, 'profiles') + path.sep
  for (const argument of argv) {
    if (typeof argument !== 'string' || !argument.startsWith(prefix)) continue
    const name = argument.slice(prefix.length)
    if (name.length > 0) return name
  }
  const configured = env.DSH_PROFILE
  return typeof configured === 'string' && configured.length > 0 ? configured : null
}

/**
 * @param {string} directory
 * @returns {string[]} Immediate entry names, or an empty list when unreadable.
 */
function listDirectory(directory) {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

/**
 * @param {string} file
 * @returns {object|null} Parsed JSON object, or null when missing or invalid.
 */
function readJsonObject(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/**
 * @param {string} file
 * @returns {string|null} File text, or null when unreadable.
 */
function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * Parse a Cordis configuration file. `!!js` expressions are opaque values
 * here: the diagnostic only needs the document structure, so they are
 * rewritten to plain strings before parsing.
 * @param {string} text Configuration text.
 * @returns {unknown} Parsed document.
 */
export function parseCordisYaml(text) {
  return parseYaml(text.replaceAll('!!js', '!!str'), { prettyErrors: true })
}

/**
 * @param {string} directory
 * @returns {string} `~`-relative display form for a directory.
 */
function displayPath(directory, home = homedir()) {
  return directory.startsWith(home) ? '~' + directory.slice(home.length) : directory
}

/**
 * Redact a message so a pasted report never carries absolute user paths.
 * @param {string} text Message to redact.
 * @param {string} home User home directory.
 * @param {string} dshHome DSH home directory.
 * @returns {string} Redacted message.
 */
export function redact(text, home, dshHome) {
  return text
    .split(dshHome).join('$DSH_HOME')
    .split(home).join('~')
}

/**
 * @param {string} id
 * @param {string} title
 * @param {Status} status
 * @param {string} detail
 * @param {string} [hint]
 * @returns {Finding}
 */
function finding(id, title, status, detail, hint) {
  return hint === undefined ? { id, title, status, detail } : { id, title, status, detail, hint }
}

/**
 * Inspect the profile manifest: bundles list, name, and dependency block.
 * @param {string} profileDir
 * @returns {{manifest: object|null, bundles: string[], dependencies: Record<string, string>, finding: Finding}}
 */
function inspectManifest(profileDir, redactText) {
  const file = path.join(profileDir, 'package.json')
  const manifest = readJsonObject(file)
  if (manifest === null) {
    return {
      manifest: null,
      bundles: [],
      dependencies: {},
      finding: finding('profile/manifest', 'Profile manifest', 'fail',
        `No readable package.json at ${redactText(displayPath(profileDir))}.`, 'Recreate the profile: `dsh --profile <name> --from-default-profile web`'),
    }
  }
  const profile = manifest.dsh?.profile
  const bundles = Array.isArray(profile?.bundles) ? profile.bundles.filter(entry => typeof entry === 'string') : []
  const dependencies = typeof manifest.dependencies === 'object' && manifest.dependencies !== null
    ? manifest.dependencies
    : {}
  if (bundles.length === 0) {
    return {
      manifest,
      bundles,
      dependencies,
      finding: finding('profile/manifest', 'Profile manifest', 'warn',
        'The manifest declares no `dsh.profile.bundles`; the profile composes nothing beyond defaults.',
        'Add the bundle you rely on, or reset the profile from an application template.'),
    }
  }
  return {
    manifest,
    bundles,
    dependencies,
    finding: finding('profile/manifest', 'Profile manifest', 'pass',
      `${String(bundles.length)} bundle(s): ${bundles.join(', ')}.`),
  }
}

/**
 * Resolve one bundle in the profile's `node_modules` and report what it contributes.
 *
 * In-box bundles — every bundle absent from the profile's `dependencies` —
 * resolve from the dsh installation itself, because pnpm manages only
 * out-of-tree packages. Requiring them to appear in the profile's
 * `node_modules` would report a healthy profile as broken.
 * @param {string} profileDir
 * @param {string} bundle
 * @param {string|null} hostVersion
 * @param {Record<string, string>} dependencies
 * @returns {Finding}
 */
function inspectBundle(profileDir, bundle, hostVersion, dependencies, redactText) {
  if (!(bundle in dependencies)) {
    return finding(`bundle/${bundle}`, `Bundle ${bundle}`, 'pass',
      'In-box bundle; resolved from the dsh installation, not from this profile.')
  }
  const bundleDir = path.join(profileDir, 'node_modules', bundle)
  const manifest = readJsonObject(path.join(bundleDir, 'package.json'))
  if (manifest === null) {
    return finding(`bundle/${bundle}`, `Bundle ${bundle}`, 'fail',
      'Not installed in this profile, or its package.json is unreadable.',
      `Install it: \`dsh plugin --profile <name> add ${bundle}\``)
  }
  const patch = manifest.dsh?.bundle?.patch
  if (patch === undefined) {
    return finding(`bundle/${bundle}`, `Bundle ${bundle}`, 'warn',
      `Installed as a plain dependency (version ${String(manifest.version ?? 'unknown')}); it contributes no configuration layer.`,
      'Only bundles that declare `dsh.bundle` take effect as plugins.')
  }
  const patchFiles = Array.isArray(patch) ? patch : [patch]
  const missing = patchFiles.filter(entry => typeof entry !== 'string' || !existsSync(path.resolve(bundleDir, entry)))
  if (missing.length > 0) {
    return finding(`bundle/${bundle}`, `Bundle ${bundle}`, 'fail',
      `Declared patch file(s) missing: ${missing.join(', ')}.`,
      'Reinstall the bundle; a partial checkout is the usual cause.')
  }
  const range = manifest.engines?.dsh
  if (typeof range === 'string' && typeof hostVersion === 'string') {
    const rangeSatisfied = semver.valid(hostVersion) === null
      ? null
      : semver.satisfies(hostVersion, range, { includePrerelease: true })
    if (rangeSatisfied === false) {
      return finding(`bundle/${bundle}`, `Bundle ${bundle}`, 'fail',
        `Requires dsh ${range}, running host is ${hostVersion}.`,
        'Update the bundle, or pin a host version inside its range.')
    }
  }
  const notes = [`version ${String(manifest.version ?? 'unknown')}`, 'declares a patch layer']
  if (typeof range === 'string') notes.push(`dsh ${range}`)
  return finding(`bundle/${bundle}`, `Bundle ${bundle}`, 'pass', notes.join(', ') + '.')
}

/**
 * Parse the profile's own patch layer and report structural problems.
 * @param {string} profileDir
 * @returns {Finding}
 */
function inspectPatchLayer(profileDir, redactText) {
  const file = path.join(profileDir, 'cordis.patch.yml')
  const text = readText(file)
  if (text === null) {
    return finding('profile/patch', 'Profile patch layer', 'warn',
      'No `cordis.patch.yml`; the profile applies only bundle layers.',
      'Create an empty patch file (`[]`) to keep local overrides in one place.')
  }
  let document
  try {
    document = parseCordisYaml(text)
  } catch (error) {
    return finding('profile/patch', 'Profile patch layer', 'fail',
      `YAML does not parse: ${String(error.message).split('\n')[0]}.`,
      'Fix the syntax; an unreadable patch layer prevents the profile from booting.')
  }
  if (document === null || document === undefined) {
    return finding('profile/patch', 'Profile patch layer', 'pass', 'Empty patch layer.')
  }
  if (!Array.isArray(document)) {
    return finding('profile/patch', 'Profile patch layer', 'fail',
      `Top level must be a YAML array of patch entries, found ${typeof document}.`,
      'Wrap the entries in a list.')
  }
  const ids = []
  const insertedRows = []
  for (const entry of document) {
    if (typeof entry !== 'object' || entry === null) {
      return finding('profile/patch', 'Profile patch layer', 'fail',
        'A patch entry is not an object.', 'Each entry needs an `id` or an `insert` list.')
    }
    if (typeof entry.id === 'string') ids.push(entry.id)
    if (Array.isArray(entry.insert)) {
      for (const row of entry.insert) {
        if (typeof row?.name === 'string') insertedRows.push(row.name)
        if (typeof row?.id === 'string') ids.push(row.id)
      }
    }
  }
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (duplicates.length > 0) {
    return finding('profile/patch', 'Profile patch layer', 'warn',
      `Duplicate row id(s): ${[...new Set(duplicates)].join(', ')}.`,
      'Later rows replace earlier ones by id; confirm the last definition is the intended one.')
  }
  const summary = `${String(document.length)} entr(ies), ${String(ids.length)} row id(s)` +
    (insertedRows.length > 0 ? `, inserts: ${insertedRows.join(', ')}` : '')
  return finding('profile/patch', 'Profile patch layer', 'pass', `${summary}.`)
}

/**
 * Verify that local `link:` and `file:` dependencies still point at something.
 * @param {Record<string, string>} dependencies
 * @param {string} profileDir
 * @returns {Finding}
 */
function inspectLocalDependencies(dependencies, profileDir, redactText) {
  const local = Object.entries(dependencies).filter(([, spec]) => /^(link|file):/.test(String(spec)))
  if (local.length === 0) {
    return finding('profile/local-links', 'Local plugin links', 'skip', 'No `link:` or `file:` dependencies.')
  }
  const broken = []
  for (const [name, spec] of local) {
    const target = String(spec).replace(/^(link|file):/, '')
    if (!existsSync(path.resolve(profileDir, target))) broken.push(`${name} (${redactText(displayPath(path.resolve(profileDir, target)))} is missing)`)
  }
  if (broken.length > 0) {
    return finding('profile/local-links', 'Local plugin links', 'fail',
      `Broken local target(s): ${broken.join('; ')}.`,
      'Restore the directory or reinstall the bundle from an existing path; a link to a moved checkout fails at load.')
  }
  return finding('profile/local-links', 'Local plugin links', 'pass',
    `${String(local.length)} local dependency target(s) resolve: ${local.map(([name]) => name).join(', ')}.`)
}

/**
 * Flag leftover backup files and abandoned profile copies.
 * @param {string} profileDir
 * @param {string} profileName
 * @returns {Finding}
 */
function inspectBackups(profileDir, profileName, redactText) {
  const backups = listDirectory(profileDir).filter(name => /\.(bak|before|working)-/.test(name))
  const abandoned = listDirectory(path.dirname(profileDir)).filter(name => name.startsWith(`${profileName}.broken-`))
  if (backups.length === 0 && abandoned.length === 0) {
    return finding('profile/backups', 'Backup residue', 'pass', 'No stale backups in or beside this profile.')
  }
  const notes = []
  if (backups.length > 0) notes.push(`${String(backups.length)} backup file(s) such as ${backups[0]}`)
  for (const name of abandoned.slice(0, 3)) {
    const modified = statSync(path.join(path.dirname(profileDir), name)).mtime.toISOString().slice(0, 10)
    notes.push(`abandoned profile ${name} (last change ${modified})`)
  }
  return finding('profile/backups', 'Backup residue', 'warn',
    `${notes.join('; ')}.`,
    'Keep one known-good copy, then remove the rest; stale copies hide the layer a working profile actually used.')
}

/**
 * Check the DSH home directory itself: presence, writability, free space, and
 * whether credential storage is readable by other users.
 * @param {string} dshHome
 * @returns {Finding[]}
 */
function inspectHome(dshHome, redactText) {
  const findings = []
  if (!existsSync(dshHome)) {
    return [finding('home/exists', 'DSH home', 'fail',
      `No directory at ${redactText(displayPath(dshHome))}.`,
      'Start DSH once to create it, or point `DSH_HOME` at the right directory.')]
  }
  findings.push(finding('home/exists', 'DSH home', 'pass', `${redactText(displayPath(dshHome))} exists.`))
  try {
    accessSync(dshHome, constants.W_OK)
    findings.push(finding('home/writable', 'DSH home writable', 'pass', 'The current user can write here.'))
  } catch {
    findings.push(finding('home/writable', 'DSH home writable', 'fail',
      'Not writable by the current user.',
      'Fix ownership or permissions on the DSH home; profiles, sessions, and caches all write there.'))
  }
  try {
    const stats = statfsSync(dshHome)
    const free = Number(stats.bavail) * Number(stats.bsize)
    const gigabytes = free / 1024 ** 3
    findings.push(free < LOW_DISK_BYTES
      ? finding('home/disk', 'Free space', 'warn',
        `${gigabytes.toFixed(1)} GiB free; under the ${String(LOW_DISK_BYTES / 1024 ** 3)} GiB mark.`,
        'Free space before installing or upgrading; a full volume corrupts in-flight session writes.')
      : finding('home/disk', 'Free space', 'pass', `${gigabytes.toFixed(1)} GiB free.`))
  } catch (error) {
    findings.push(finding('home/disk', 'Free space', 'skip', `Could not read filesystem statistics: ${String(error.message)}.`))
  }
  const credentials = path.join(dshHome, '.credentials.yaml')
  if (!existsSync(credentials)) {
    findings.push(finding('home/credentials', 'Credential file', 'skip',
      'No `.credentials.yaml`; the CLI and Desktop may authenticate per run instead.'))
  } else {
    const mode = statSync(credentials).mode & 0o777
    const groupOrOtherReadable = (mode & 0o077) !== 0
    findings.push(groupOrOtherReadable
      ? finding('home/credentials', 'Credential file', 'warn',
        `Present, but mode ${mode.toString(8)} allows group or other access.`,
        'Restrict it: `chmod 600 ~/.dsh/.credentials.yaml`.')
      : finding('home/credentials', 'Credential file', 'pass', `Present, mode ${mode.toString(8)}. Contents were not read.`))
  }
  return findings
}

/**
 * Check the Node.js version against the runtime floor.
 * @param {string} nodeVersion
 * @param {string} nodeFloor
 * @returns {Finding}
 */
function inspectNode(nodeVersion, nodeFloor) {
  const satisfies = semver.satisfies(nodeVersion.replace(/^v/, ''), nodeFloor, { includePrerelease: true })
  return satisfies
    ? finding('runtime/node', 'Node.js version', 'pass', `${nodeVersion} satisfies ${nodeFloor}.`)
    : finding('runtime/node', 'Node.js version', 'fail',
      `${nodeVersion} is outside ${nodeFloor}.`,
      'Install a supported Node.js; the build and several plugins assume the newer runtime.')
}

/**
 * Inspect one profile and its surroundings.
 * @param {string} dshHome
 * @param {string} profileDir Absolute profile directory.
 * @param {string} profileName Profile name.
 * @param {string|null} hostVersion Running host version, when known.
 * @param {(text: string) => string} redactText
 * @returns {Finding[]}
 */
function inspectProfile(dshHome, profileDir, profileName, hostVersion, redactText) {
  const findings = [finding('profile/exists', 'Profile directory', 'pass', `${redactText(displayPath(profileDir))}.`)]
  const { bundles, dependencies, finding: manifestFinding } = inspectManifest(profileDir, redactText)
  findings.push(manifestFinding)
  for (const bundle of bundles) findings.push(inspectBundle(profileDir, bundle, hostVersion, dependencies, redactText))
  findings.push(inspectPatchLayer(profileDir, redactText))
  findings.push(inspectLocalDependencies(dependencies, profileDir, redactText))
  findings.push(inspectBackups(profileDir, profileName, redactText))
  const lock = path.join(profileDir, 'pnpm-lock.yaml')
  findings.push(existsSync(lock)
    ? finding('profile/lockfile', 'Profile lockfile', 'pass', 'pnpm-lock.yaml present.')
    : finding('profile/lockfile', 'Profile lockfile', 'warn',
      'No pnpm-lock.yaml; installed bundle versions may drift between runs.',
      'Run any `dsh plugin --profile <name> install` to materialize the lockfile.'))
  findings.push(...inspectHome(dshHome, redactText))
  return findings
}

/**
 * Run every enabled check and assemble a report.
 * @param {object} [options]
 * @param {string} [options.dshHome] DSH home directory; defaults to the launcher's resolution.
 * @param {string} [options.profile] Profile name to inspect; defaults to detection.
 * @param {string[]} [options.argv] Host process arguments, for profile detection.
 * @param {NodeJS.ProcessEnv} [options.env] Host environment, for profile detection.
 * @param {string} [options.nodeVersion] Node.js version to report.
 * @param {string} [options.nodeFloor] Node.js range to enforce.
 * @param {Date} [options.now] Clock, for tests.
 * @returns {Report}
 */
export function runDoctor(options = {}) {
  const env = options.env ?? process.env
  const dshHome = options.dshHome ?? defaultDshHome(env)
  const home = homedir()
  const redactText = (text) => redact(text, home, dshHome)
  const profileName = options.profile ?? detectProfileName({ argv: options.argv ?? process.argv, dshHome, env })
  const hostVersion = env.DSH_CLIENT_VERSION ?? null
  const findings = [inspectNode(options.nodeVersion ?? process.version, options.nodeFloor ?? DEFAULT_NODE_FLOOR)]
  if (profileName === null) {
    const available = listDirectory(path.join(dshHome, 'profiles'))
    findings.push(finding('profile/current', 'Current profile', available.length === 0 ? 'fail' : 'warn',
      available.length === 0
        ? 'No profiles exist under the DSH home.'
        : `Launch argument did not name a profile; available: ${available.join(', ')}.`,
      'Pass `profile` explicitly, or launch with `--profile <name>`.'))
    findings.push(...inspectHome(dshHome, redactText))
  } else {
    const profileDir = path.join(dshHome, 'profiles', profileName)
    if (!existsSync(profileDir)) {
      findings.push(finding('profile/exists', 'Profile directory', 'fail',
        `No profile named "${profileName}" under ${redactText(displayPath(path.join(dshHome, 'profiles')))}.`,
        'List the available profiles, then pass the exact name.'))
      findings.push(...inspectHome(dshHome, redactText))
    } else {
      findings.push(...inspectProfile(dshHome, profileDir, profileName, hostVersion, redactText))
    }
  }
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const entry of findings) summary[entry.status] += 1
  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    platform: `${platform()} ${arch()}`,
    node: options.nodeVersion ?? process.version,
    dshHome: redactText(displayPath(dshHome)),
    profile: profileName,
    findings,
    summary,
  }
}

/**
 * Render a report as Markdown suitable for pasting into a GitHub Discussion.
 * @param {Report} report
 * @returns {string} Markdown report.
 */
export function renderReport(report) {
  const statusLabel = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' }
  const lines = [
    '# DSH Doctor report',
    '',
    `- generated: ${report.generatedAt}`,
    `- platform: ${report.platform}`,
    `- node: ${report.node}`,
    `- dsh home: \`${report.dshHome}\``,
    `- profile: ${report.profile === null ? '(not detected)' : `\`${report.profile}\``}`,
    `- summary: ${String(report.summary.pass)} pass, ${String(report.summary.warn)} warn, ${String(report.summary.fail)} fail, ${String(report.summary.skip)} skip`,
    '',
    '| Check | Status | Detail |',
    '|---|---|---|',
    ...report.findings.map(entry => `| ${entry.id} | ${statusLabel[entry.status]} | ${escapePipes(entry.detail)} |`),
    '',
    '## Details',
  ]
  for (const entry of report.findings) {
    lines.push('', `### ${entry.id} — ${statusLabel[entry.status]}`, '', entry.title, '', entry.detail)
    if (entry.hint !== undefined) lines.push('', `Hint: ${entry.hint}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * @param {string} text
 * @returns {string} Cell text safe inside a Markdown table.
 */
function escapePipes(text) {
  return text.split('|').join('\\|')
}
