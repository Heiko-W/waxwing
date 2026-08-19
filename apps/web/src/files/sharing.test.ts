/**
 * The share rights model (M5.18).
 *
 * Two properties carry the weight. Rights another client set must come back as `custom` rather
 * than being snapped to the nearest role — that is someone else's decision about someone else's
 * access. And every edit must carry the OTHER grantees across, because `FileNode/set` replaces the
 * whole `shareWith` map and anyone missing from it loses access without a word.
 */

import type { FileNodeRights } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { grantees, mayShare, rightsFor, roleOf, withGrant, withoutGrant } from './sharing'

const ALL_KEYS: (keyof FileNodeRights)[] = [
  'mayRead',
  'mayAddChildren',
  'mayRename',
  'mayDelete',
  'mayModifyContent',
  'mayShare',
]

describe('what each role grants', () => {
  it('gives a viewer read and nothing else', () => {
    expect(rightsFor('viewer')).toEqual({
      mayRead: true,
      mayAddChildren: false,
      mayRename: false,
      mayDelete: false,
      mayModifyContent: false,
      mayShare: false,
    })
  })

  it('gives an editor everything except the right to re-share', () => {
    // The line that matters: an editor can change the file, not who else can.
    expect(rightsFor('editor').mayShare).toBe(false)
    expect(rightsFor('editor').mayModifyContent).toBe(true)
    expect(rightsFor('editor').mayDelete).toBe(true)
  })

  it('gives mayShare to the manager role ALONE', () => {
    // `mayShare` hands out access the owner never approved and generates no notification to them.
    // If a second role ever grants it, this fails — which is the point.
    const withShare = (['viewer', 'editor', 'manager'] as const).filter(
      (role) => rightsFor(role).mayShare,
    )
    expect(withShare).toEqual(['manager'])
  })

  it('returns a fresh object each time', () => {
    const first = rightsFor('editor')
    first.mayShare = true
    expect(rightsFor('editor').mayShare).toBe(false)
  })

  it('always names every right, so a grant is never partial', () => {
    for (const role of ['viewer', 'editor', 'manager'] as const) {
      expect(Object.keys(rightsFor(role)).sort(), role).toEqual([...ALL_KEYS].sort())
    }
  })
})

describe('reading rights back', () => {
  it('round-trips every role', () => {
    for (const role of ['viewer', 'editor', 'manager'] as const) {
      expect(roleOf(rightsFor(role)), role).toBe(role)
    }
  })

  it('calls a combination no role produces custom', () => {
    // Delete without read: the server accepts it, and it is nobody's idea of a role.
    expect(roleOf({ ...rightsFor('viewer'), mayRead: false, mayDelete: true })).toBe('custom')
    // Read plus re-share, without edit — a real thing another client might set.
    expect(roleOf({ mayRead: true, mayShare: true })).toBe('custom')
  })

  it('treats an absent right as false rather than as a wildcard', () => {
    // A partial object must not match a role by accident: `{mayRead: true}` IS viewer.
    expect(roleOf({ mayRead: true })).toBe('viewer')
    expect(roleOf({})).toBe('custom')
  })

  it('calls a missing entry custom rather than inventing a role', () => {
    expect(roleOf(null)).toBe('custom')
    expect(roleOf(undefined)).toBe('custom')
  })
})

describe('editing the grant map', () => {
  const existing = { alice: rightsFor('viewer'), bob: rightsFor('editor') }

  it('carries every other grantee across when adding one', () => {
    const next = withGrant(existing, 'carol', 'viewer')
    expect(Object.keys(next).sort()).toEqual(['alice', 'bob', 'carol'])
    expect(next.bob).toEqual(rightsFor('editor'))
  })

  it('carries every other grantee across when removing one', () => {
    const next = withoutGrant(existing, 'alice')
    expect(Object.keys(next)).toEqual(['bob'])
    expect(next.bob).toEqual(rightsFor('editor'))
  })

  it('replaces rather than merges when a grantee is regranted', () => {
    // Downgrading a manager to a viewer must not leave mayShare behind.
    const next = withGrant({ bob: rightsFor('manager') }, 'bob', 'viewer')
    expect(next.bob).toEqual(rightsFor('viewer'))
    expect(next.bob?.mayShare).toBe(false)
  })

  it('does not mutate the map it was given', () => {
    const before = { ...existing }
    withGrant(existing, 'carol', 'manager')
    withoutGrant(existing, 'alice')
    expect(existing).toEqual(before)
  })

  it('starts from nothing when the node was never shared', () => {
    expect(withGrant(null, 'bob', 'viewer')).toEqual({ bob: rightsFor('viewer') })
    expect(withoutGrant(undefined, 'bob')).toEqual({})
  })
})

describe('listing grantees', () => {
  it('names the role of each', () => {
    expect(grantees({ b: rightsFor('editor'), a: rightsFor('viewer') })).toEqual([
      { principalId: 'a', role: 'viewer' },
      { principalId: 'b', role: 'editor' },
    ])
  })

  it('shows a foreign combination as custom instead of hiding it', () => {
    expect(grantees({ a: { mayDelete: true } })).toEqual([{ principalId: 'a', role: 'custom' }])
  })

  it('is empty for a node nobody has been given', () => {
    expect(grantees(null)).toEqual([])
    expect(grantees({})).toEqual([])
  })
})

describe('whether sharing is offered', () => {
  it('follows the server, which answers for the current user', () => {
    expect(mayShare(rightsFor('manager'))).toBe(true)
    expect(mayShare(rightsFor('editor'))).toBe(false)
  })
})
