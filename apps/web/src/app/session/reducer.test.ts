import { describe, expect, it } from 'vitest'
import {
  INITIAL_SESSION_STATE,
  makeSessionReducer,
  type OnboardEnv,
  type SessionState,
} from './reducer'
import type { ConnectedSession, ConnectTarget } from './types'

const ENV: OnboardEnv = { methods: ['oauth', 'basic'], oauthAvailable: true }
const reduce = makeSessionReducer(ENV)

const TARGET: ConnectTarget = {
  connectUrl: 'https://mail.example.com',
  issuer: 'https://mail.example.com',
  displayHost: 'mail.example.com',
  fromProbe: false,
}

function conn(id: string): ConnectedSession {
  return {
    client: {} as ConnectedSession['client'],
    jmapSession: {} as ConnectedSession['jmapSession'],
    accountId: id,
    accounts: [{ id, name: id, isPersonal: true, isReadOnly: false }],
    delegated: [],
    username: id,
    method: 'basic',
  }
}

function ready(): SessionState {
  return reduce({ status: 'connecting' }, { type: 'connected', connected: conn('a') })
}

describe('session reducer', () => {
  it('starts booting', () => {
    expect(INITIAL_SESSION_STATE).toEqual({ status: 'booting' })
  })

  it('shows the connect step with an editable server field', () => {
    const state = reduce(INITIAL_SESSION_STATE, { type: 'showConnect' })
    expect(state).toMatchObject({
      status: 'onboarding',
      view: { step: 'connect', canEditServer: true, methods: [], busy: false, error: null },
    })
  })

  it('derives the login view from env + target', () => {
    const state = reduce(INITIAL_SESSION_STATE, {
      type: 'showLogin',
      target: TARGET,
      canEditServer: false,
    })
    expect(state).toMatchObject({
      status: 'onboarding',
      view: {
        step: 'login',
        target: TARGET,
        methods: ['oauth', 'basic'],
        oauthAvailable: true,
        canEditServer: false,
        busy: false,
        error: null,
      },
    })
  })

  it('marks the onboarding view busy then surfaces a login error', () => {
    const login = reduce(INITIAL_SESSION_STATE, {
      type: 'showLogin',
      target: TARGET,
      canEditServer: true,
    })
    const busy = reduce(login, { type: 'submitBusy' })
    expect(busy).toMatchObject({ status: 'onboarding', view: { busy: true, error: null } })
    const errored = reduce(busy, { type: 'loginError', error: { key: 'auth.error.generic' } })
    expect(errored).toMatchObject({
      status: 'onboarding',
      view: { busy: false, error: { key: 'auth.error.generic' } },
    })
  })

  it('connects to a ready session with no pending reauth', () => {
    const state = reduce({ status: 'connecting' }, { type: 'connected', connected: conn('acc') })
    expect(state).toMatchObject({ status: 'ready', reauth: null })
    expect(state.status === 'ready' && state.connected.accountId).toBe('acc')
  })

  it('flips the reauth overlay once and ignores repeats (idempotent)', () => {
    const first = reduce(ready(), {
      type: 'reauthRequired',
      method: 'oauth',
      requiresRedirect: true,
    })
    expect(first).toMatchObject({
      status: 'ready',
      reauth: { method: 'oauth', requiresRedirect: true },
    })
    const second = reduce(first, {
      type: 'reauthRequired',
      method: 'oauth',
      requiresRedirect: true,
    })
    expect(second).toBe(first)
  })

  it('ignores reauth actions when not connected', () => {
    const booting: SessionState = { status: 'booting' }
    expect(
      reduce(booting, { type: 'reauthRequired', method: 'basic', requiresRedirect: false }),
    ).toBe(booting)
  })

  it('carries busy/error only while a reauth overlay is open, then clears it', () => {
    const open = reduce(ready(), {
      type: 'reauthRequired',
      method: 'basic',
      requiresRedirect: false,
    })
    const busy = reduce(open, { type: 'reauthBusy' })
    expect(busy).toMatchObject({ reauth: { busy: true, error: null } })
    const errored = reduce(busy, {
      type: 'reauthError',
      error: { key: 'auth.error.invalidCredentials' },
    })
    expect(errored).toMatchObject({
      reauth: { busy: false, error: { key: 'auth.error.invalidCredentials' } },
    })
    const cleared = reduce(errored, { type: 'reauthCleared' })
    expect(cleared).toMatchObject({ status: 'ready', reauth: null })
  })

  it('swaps the client on Basic reconnect and clears the overlay', () => {
    const open = reduce(ready(), {
      type: 'reauthRequired',
      method: 'basic',
      requiresRedirect: false,
    })
    const state = reduce(open, { type: 'reconnected', connected: conn('acc2') })
    expect(state).toMatchObject({ status: 'ready', reauth: null })
    expect(state.status === 'ready' && state.connected.accountId).toBe('acc2')
  })
})
