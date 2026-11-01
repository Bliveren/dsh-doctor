import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { detectProfileName, parseCordisYaml, redact, renderReport, runDoctor } from '../lib/checks.js'

/**
 * Materialize a fixture DSH home.
 * @param {(home: string) => void} build Receives the created home directory.
 * @returns {string} Fixture home directory.
 */
function fixture(build) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-doctor-'))
  build(home)
  return home
}

test('detectProfileName reads the profile directory argument', () => {
  const dshHome = path.join(path.sep, 'tmp', 'dsh-home')
  const profileDir = path.join(dshHome, 'profiles', 'desktop')
  assert.equal(detectProfileName({ argv: ['dsh', '--profile', profileDir], dshHome, env: {} }), 'desktop')
})

test('detectProfileName falls back to DSH_PROFILE and then null', () => {
  assert.equal(detectProfileName({ argv: [], dshHome: '/tmp/x', env: { DSH_PROFILE: 'web' } }), 'web')
  assert.equal(detectProfileName({ argv: [], dshHome: '/tmp/x', env: {} }), null)
})

test('parseCordisYaml accepts !!js values', () => {
  const document = parseCordisYaml('- id: llm\n  config:\n    port: !!js ctx.port ?? 3080\n')
  assert.equal(Array.isArray(document), true)
  assert.equal(typeof document[0].config.port, 'string')
})

test('redact removes home and DSH home paths', () => {
  const home = path.join(path.sep, 'Users', 'someone')
  const dshHome = path.join(home, '.dsh')
  assert.equal(redact(`${dshHome}/profiles/x and ${home}/y`, home, dshHome), '$DSH_HOME/profiles/x and ~/y')
})

test('a healthy profile produces no failures', () => {
  const home = fixture(dshHome => {
    const profile = path.join(dshHome, 'profiles', 'desktop')
    mkdirSync(path.join(profile, 'node_modules', 'demo-bundle'), { recursive: true })
    writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n')
    writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      dependencies: { 'demo-bundle': '1.0.0' },
      dsh: { profile: { bundles: ['demo-bundle'] } },
    }))
    writeFileSync(path.join(profile, 'node_modules', 'demo-bundle', 'package.json'), JSON.stringify({
      name: 'demo-bundle',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(path.join(profile, 'node_modules', 'demo-bundle', 'cordis.patch.yml'), '- insert: []\n')
  })
  const report = runDoctor({ dshHome: home, profile: 'desktop', env: {}, nodeVersion: 'v24.21.0' })
  assert.deepEqual(report.summary.fail, 0)
  assert.equal(report.summary.pass > 0, true)
  rmSync(home, { recursive: true, force: true })
})

test('a missing bundle is a failure with an install hint', () => {
  const home = fixture(dshHome => {
    const profile = path.join(dshHome, 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
      dependencies: { 'absent-bundle': '1.0.0' },
      dsh: { profile: { bundles: ['absent-bundle'] } },
    }))
  })
  const report = runDoctor({ dshHome: home, profile: 'desktop', env: {}, nodeVersion: 'v24.21.0' })
  const failure = report.findings.find(entry => entry.id === 'bundle/absent-bundle')
  assert.equal(failure?.status, 'fail')
  assert.match(failure.hint ?? '', /dsh plugin/)
  rmSync(home, { recursive: true, force: true })
})

test('an in-box bundle needs no profile installation', () => {
  const home = fixture(dshHome => {
    const profile = path.join(dshHome, 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }))
  })
  const report = runDoctor({ dshHome: home, profile: 'desktop', env: {}, nodeVersion: 'v24.21.0' })
  assert.equal(report.findings.find(entry => entry.id === 'bundle/@deepseek-ai/dsh-base')?.status, 'pass')
  rmSync(home, { recursive: true, force: true })
})

test('an unparsable patch layer is a failure', () => {
  const home = fixture(dshHome => {
    const profile = path.join(dshHome, 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    writeFileSync(path.join(profile, 'cordis.patch.yml'), '- id: broken\n  config: [unclosed\n')
  })
  const report = runDoctor({ dshHome: home, profile: 'desktop', env: {}, nodeVersion: 'v24.21.0' })
  const failure = report.findings.find(entry => entry.id === 'profile/patch')
  assert.equal(failure?.status, 'fail')
  rmSync(home, { recursive: true, force: true })
})

test('a broken link dependency is a failure', () => {
  const home = fixture(dshHome => {
    const profile = path.join(dshHome, 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
      dependencies: { '@local/plugin': 'link:/nowhere/plugin' },
      dsh: { profile: { bundles: [] } },
    }))
  })
  const report = runDoctor({ dshHome: home, profile: 'desktop', env: {}, nodeVersion: 'v24.21.0' })
  const failure = report.findings.find(entry => entry.id === 'profile/local-links')
  assert.equal(failure?.status, 'fail')
  rmSync(home, { recursive: true, force: true })
})

test('an old Node.js version fails the runtime check', () => {
  const report = runDoctor({ dshHome: path.join(tmpdir(), 'dsh-doctor-absent'), env: {}, nodeVersion: 'v22.1.0' })
  assert.equal(report.findings.find(entry => entry.id === 'runtime/node')?.status, 'fail')
})

test('renderReport emits a summary and a details section', () => {
  const home = fixture(dshHome => mkdirSync(path.join(dshHome, 'profiles', 'p'), { recursive: true }))
  const markdown = renderReport(runDoctor({ dshHome: home, profile: 'p', env: {}, nodeVersion: 'v24.21.0' }))
  assert.match(markdown, /# DSH Doctor report/)
  assert.match(markdown, /## Details/)
  assert.match(markdown, /\| Check \| Status \| Detail \|/)
  rmSync(home, { recursive: true, force: true })
})
