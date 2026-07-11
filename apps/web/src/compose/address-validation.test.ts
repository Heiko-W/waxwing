import { describe, expect, it } from 'vitest'
import { formatAddress, isPlausibleEmail, parseAddressList } from './address-validation'

describe('isPlausibleEmail', () => {
  it.each([
    ['a@b.co', true],
    ['first.last@sub.example.com', true],
    ['  spaced@example.com  ', true],
    ['no-at-sign', false],
    ['two@@example.com', false],
    ['missing@domain', false],
    ['no local@example.com', false],
    ['', false],
  ])('%s → %s', (input, expected) => {
    expect(isPlausibleEmail(input)).toBe(expected)
  })
})

describe('parseAddressList', () => {
  it('splits a comma list', () => {
    expect(parseAddressList('a@x.com, b@y.com')).toEqual([
      { name: null, email: 'a@x.com' },
      { name: null, email: 'b@y.com' },
    ])
  })

  it('splits a semicolon list and trims trailing separators', () => {
    expect(parseAddressList('a@x.com; b@y.com;')).toHaveLength(2)
  })

  it('parses a named address', () => {
    expect(parseAddressList('Alice A <alice@x.com>')).toEqual([
      { name: 'Alice A', email: 'alice@x.com' },
    ])
  })

  it('dequotes a quoted name', () => {
    expect(parseAddressList('"Doe, John" <john@x.com>')).toEqual([
      { name: 'Doe, John', email: 'john@x.com' },
    ])
  })

  it('mixes named and bare addresses', () => {
    expect(parseAddressList('Bob <bob@x.com>, carol@y.com')).toEqual([
      { name: 'Bob', email: 'bob@x.com' },
      { name: null, email: 'carol@y.com' },
    ])
  })

  it('keeps an unparseable token so it can flag as invalid', () => {
    expect(parseAddressList('not-an-email')).toEqual([{ name: null, email: 'not-an-email' }])
  })
})

describe('formatAddress', () => {
  it('renders named vs bare', () => {
    expect(formatAddress({ name: 'Al', email: 'al@x.com' })).toBe('Al <al@x.com>')
    expect(formatAddress({ name: null, email: 'al@x.com' })).toBe('al@x.com')
    expect(formatAddress({ name: '', email: 'al@x.com' })).toBe('al@x.com')
  })
})
