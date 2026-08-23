/**
 * Bundle invariants that hold between packages, and therefore belong to none of
 * them.
 *
 * The important one is row uniqueness. A dsh profile is assembled by layering
 * each installed bundle's patch, and **a row id inserted by two layers mounts the
 * plugin twice**. Two copies of a channel plugin means every message answered
 * twice; two copies of a service means the second silently shadows the first.
 * Nothing inside a single package can detect that, because it needs a view of
 * every package at once.
 *
 * The rest is manifest hygiene: a patch that is not listed in `files` ships a
 * package that cannot be installed as a bundle, which fails at the user's
 * machine rather than here.
 */

import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/tests$/, '')

/** One insert operation from a patch file. */
interface InsertOp {
  insert?: { id?: string; name?: string; config?: unknown }[]
  id?: string
  config?: unknown
}

/** A package, its manifest, and its parsed patch. */
interface Bundle {
  dir: string
  manifest: {
    name?: string
    files?: string[]
    exports?: Record<string, unknown>
    dsh?: { bundle?: { patch?: string } }
    peerDependencies?: Record<string, string>
  }
  patchText: string
  patch: InsertOp[]
}

/** Every workspace package that declares itself a bundle. */
async function bundles(): Promise<Bundle[]> {
  const workspace = yaml.load(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')) as { packages: string[] }
  const entries = await readdir(ROOT, { withFileTypes: true })
  const dirs = workspace.packages.filter(name =>
    entries.some(entry => entry.isDirectory() && entry.name === name))
  return dirs.map((dir) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as Bundle['manifest']
    const patchText = readFileSync(join(ROOT, dir, 'cordis.patch.yml'), 'utf8')
    // Plain `load` is safe here: these patches use no `!!js` tags.
    return { dir, manifest, patchText, patch: (yaml.load(patchText) ?? []) as InsertOp[] }
  })
}

const ALL = await bundles()

describe('the workspace', () => {
  it('has a package directory for every workspace entry', () => {
    const workspace = yaml.load(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')) as { packages: string[] }
    expect(ALL.map(bundle => bundle.dir).sort()).toEqual([...workspace.packages].sort())
  })

  it('ships every capability the butler is meant to have', () => {
    expect(ALL.map(bundle => bundle.dir).sort()).toEqual([
      'dsh-briefing',
      'dsh-butler-persona',
      'dsh-caldav',
      'dsh-calendar',
      'dsh-channel-discord',
      'dsh-chores',
      'dsh-expenses',
      'dsh-household',
      'dsh-mail',
      'dsh-mail-tools',
      'dsh-occasions',
      'dsh-planner',
      'dsh-tricount',
    ])
  })
})

describe.each(ALL.map(bundle => [bundle.dir, bundle] as const))('%s', (_dir, bundle) => {
  it('parses as a list of patch operations', () => {
    expect(Array.isArray(bundle.patch)).toBe(true)
    expect(bundle.patch.length).toBeGreaterThan(0)
    for (const operation of bundle.patch) {
      // Either an insert, or an override of an existing row.
      expect(operation.insert !== undefined || operation.id !== undefined).toBe(true)
    }
  })

  it('inserts a row naming this package', () => {
    const names = bundle.patch.flatMap(operation => operation.insert ?? []).map(row => row.name)
    expect(names).toContain(bundle.manifest.name)
  })

  it('gives every inserted row an id', () => {
    for (const row of bundle.patch.flatMap(operation => operation.insert ?? [])) {
      expect(row.id, `a row in ${bundle.dir} has no id`).toBeTruthy()
    }
  })

  it('points its manifest at the patch', () => {
    expect(bundle.manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('ships the patch, or it cannot be installed as a bundle', () => {
    expect(bundle.manifest.files).toContain('cordis.patch.yml')
    expect(bundle.manifest.exports?.['./cordis.patch.yml']).toBe('./cordis.patch.yml')
  })

  it('is not marked private, which would keep it from being installed', () => {
    expect((bundle.manifest as { private?: boolean }).private).toBeUndefined()
  })

  it('explains itself, since the patch is where an operator configures it', () => {
    // Every patch carries the install command, so a reader knows what to run.
    expect(bundle.patchText).toContain('dsh plugin')
    expect(bundle.patchText.split('\n').filter(line => line.startsWith('#')).length).toBeGreaterThan(3)
  })

  it('carries no secret, only credential references', () => {
    // A patch is configuration and gets committed and shared; a password in one
    // is a password in a repository. Comments are excluded deliberately: the
    // setup instructions have to be able to say the word "password".
    const values = bundle.patchText
      .split('\n')
      .filter(line => !line.trimStart().startsWith('#'))
      .join('\n')
      .toLowerCase()
    for (const forbidden of ['password:', 'token:', 'secret:', 'apikey:']) {
      // A *Ref key is a reference by name and is exactly what should be here.
      const offending = values.split('\n').filter(line =>
        line.includes(forbidden) && !/(?:ref|refs)\s*:/.test(line))
      expect(offending, `${bundle.dir} looks like it inlines a secret`).toEqual([])
    }
  })
})

describe('row ids across every bundle', () => {
  it('are unique, because a repeated id mounts the plugin twice', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const bundle of ALL) {
      for (const row of bundle.patch.flatMap(operation => operation.insert ?? [])) {
        const id = row.id
        if (id === undefined) continue
        const owner = seen.get(id)
        if (owner !== undefined) clashes.push(`row "${id}" is inserted by both ${owner} and ${bundle.dir}`)
        else seen.set(id, bundle.dir)
      }
    }
    expect(clashes).toEqual([])
  })

  it('never restate a row another bundle owns', () => {
    // A bundle that overrides a row it does not own would fight with its owner.
    const inserted = new Set(
      ALL.flatMap(bundle => bundle.patch.flatMap(operation => operation.insert ?? []))
        .map(row => row.id)
        .filter((id): id is string => id !== undefined),
    )
    for (const bundle of ALL) {
      const overrides = bundle.patch.filter(operation => operation.insert === undefined && operation.id !== undefined)
      for (const override of overrides) {
        const ownedHere = bundle.patch
          .flatMap(operation => operation.insert ?? [])
          .some(row => row.id === override.id)
        // Overriding a core harness row is fine; overriding another bundle's is not.
        const ownedElsewhere = inserted.has(override.id!) && !ownedHere
        expect(ownedElsewhere, `${bundle.dir} overrides row "${override.id}" owned by another bundle`).toBe(false)
      }
    }
  })
})

describe('dependency declarations', () => {
  it('declare a workspace peer for every sibling package a bundle builds on', () => {
    const names = new Set(ALL.map(bundle => bundle.manifest.name))
    for (const bundle of ALL) {
      const peers = bundle.manifest.peerDependencies ?? {}
      for (const [peer, range] of Object.entries(peers)) {
        if (!names.has(peer)) continue
        expect(range, `${bundle.dir} pins sibling ${peer} to ${range}`).toBe('workspace:*')
      }
    }
  })

  it('keep the runtime libraries optional, so a household installs only what it uses', () => {
    const optionalEverywhere = ['tsdav', 'ical.js', 'discord.js', 'imapflow', 'nodemailer', 'mailparser']
    for (const bundle of ALL) {
      const peers = Object.keys(bundle.manifest.peerDependencies ?? {})
      const meta = (bundle.manifest as { peerDependenciesMeta?: Record<string, { optional?: boolean }> })
        .peerDependenciesMeta ?? {}
      for (const library of peers.filter(peer => optionalEverywhere.includes(peer))) {
        expect(meta[library]?.optional, `${bundle.dir} makes ${library} mandatory`).toBe(true)
      }
    }
  })
})
