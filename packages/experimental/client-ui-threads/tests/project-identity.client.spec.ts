/** Project identity: which Session counts as a Project, from configured preset ids alone. */
import { describe, expect, it } from 'vitest'
import { Config } from '../src/client/config.ts'
import { isProjectSession, projectAgentPreset } from '../src/client/project.ts'

describe('isProjectSession', () => {
  it('recognizes a Session composed from a configured Project preset', () => {
    expect(isProjectSession('project', ['project'])).toBe(true)
    expect(isProjectSession('project', ['standard', 'project'])).toBe(true)
  })

  it('leaves every other composition outside a Project', () => {
    expect(isProjectSession('standard', ['project'])).toBe(false)
    expect(isProjectSession('project-extra', ['project'])).toBe(false)
    expect(isProjectSession('PROJECT', ['project'])).toBe(false)
  })

  it('treats an unconfigured list, an unknown preset, and the registry null as no Project', () => {
    // Empty is the shipped default: nothing is a Project until a deployment
    // names a preset, so the roster keeps its non-empty-only behavior.
    expect(isProjectSession('project', [])).toBe(false)
    // null is the registry's own "composes nothing" answer, not a preset name.
    expect(isProjectSession(null, ['project'])).toBe(false)
    // A composition that has not been read yet is unknown, never a Project.
    expect(isProjectSession(undefined, ['project'])).toBe(false)
  })
})

describe('projectAgentPreset', () => {
  it('reads the first configured preset as the one a new Project composes', () => {
    expect(projectAgentPreset(['project', 'research'])).toBe('project')
  })

  it('has no preset to compose without configuration', () => {
    expect(projectAgentPreset([])).toBeUndefined()
  })
})

describe('Config', () => {
  it('recognizes the shipped Project preset with no deployment configuration', () => {
    // A client entry's config is never delivered to the browser half, so the
    // schema default is the ONLY value that can reach it. It must therefore name
    // the preset the shipped bundle registers.
    expect(Config({})).toEqual({ projectAgentPresets: ['project'] })
    expect(Config({ projectAgentPresets: ['project'] })).toEqual({ projectAgentPresets: ['project'] })
    expect(Config({ projectAgentPresets: ['research'] })).toEqual({ projectAgentPresets: ['research'] })
  })
})
