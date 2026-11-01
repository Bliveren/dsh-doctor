/**
 * Plugin entry: registers the `dsh_doctor` tool.
 *
 * The tool is read-only. It inspects the DSH home directory, the running
 * profile's manifest and layers, and local links, then returns a redacted
 * Markdown report that is safe to paste into a public discussion thread.
 *
 * The definition is registered as a raw JSON-Schema tool so the plugin
 * imports nothing from the host installation beyond the Cordis context it is
 * handed: no peer dependency has to resolve for it to load.
 *
 * @module dsh-doctor
 */

import { renderReport, runDoctor } from './lib/checks.js'

/** Cordis plugin name. */
export const name = 'dsh-doctor'

/** Required registries: the tool registry this plugin contributes to. */
export const inject = ['tools']

/** Model-facing argument schema. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    profile: {
      type: 'string',
      description: 'Profile name to inspect. Defaults to the profile this host was launched with.',
    },
  },
}

/** Canonical result schema: a status, a one-line summary, and the report body. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string' },
    summary: { type: 'string' },
    report: { type: 'string' },
  },
  required: ['status', 'summary', 'report'],
}

/**
 * Read and validate the optional profile argument.
 * @param {unknown} args Model arguments.
 * @returns {string|undefined} Requested profile name.
 */
function profileArgument(args) {
  if (typeof args !== 'object' || args === null) return undefined
  const value = args.profile
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('profile must be a non-empty string')
  }
  return value
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'dsh_doctor',
    description:
      'Run read-only health checks over this DeepSeek Harness installation: runtime, profile manifest, '
      + 'bundle layers, patch YAML, local link targets, backup residue, free space, and credential file permissions. '
      + 'Returns a redacted Markdown report safe to paste into a discussion thread.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const profile = profileArgument(args)
      const report = runDoctor(profile === undefined ? {} : { profile })
      const summary = `${String(report.summary.fail)} fail, ${String(report.summary.warn)} warn, ${String(report.summary.pass)} pass`
      return {
        status: report.summary.fail > 0 ? 'attention' : 'ok',
        summary,
        report: renderReport(report),
      }
    },
  })
}
