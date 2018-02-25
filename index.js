const assert = require('assert')
const parseUrl = require('url').parse

const cloneDeep = require('lodash/cloneDeep')
const merge = require('lodash/merge')
const pick = require('lodash/pick')
const nock = require('nock')
const headers = require('./lib/headers')
const diffString = require('json-diff').diffString

module.exports = {
  // don’t use short syntax for node@4 compatibility
  get: get,
  mock: mock,
  nock: nock
}

function get (name) {
  return require(`./scenarios/${name}/normalized-fixture.json`)
}

function mock (fixtures, additions) {
  if (typeof fixtures === 'string') {
    fixtures = get(fixtures)
  }
  fixtures = cloneDeep(fixtures)

  if (additions) {
    const applyAdditions = typeof additions === 'function'
      ? additions
      : applyAdditionsDefault.bind(null, additions)
    fixtures.forEach((fixture, i) => {
      fixtures[i] = applyAdditions(fixture)
    })
  }

  fixtures.forEach(fixture => {
    fixture.rawHeaders = headers.toArray(fixture.headers)
    delete fixture.headers
  })

  const mocks = nock.define(fixtures)

  const api = {
    pending () {
      return [].concat.apply([], mocks.map(mock => mock.pendingMocks()))
    },
    explain (error) {
      if (!/^Nock: No match/.test(error.message)) {
        throw error
      }

      const expected = getNextMockConfig(mocks)
      const actualString = error.message
        .substr('Nock: No match for request '.length)
        .replace(/\s+Got instead(.|[\r\n])*$/, '')

      const requestConfig = JSON.parse(actualString)
      const actual = pick(requestConfig, Object.keys(expected))
      actual.headers = pick(requestConfig.headers, Object.keys(expected.headers))
      error.message = `Request did not match mock ${api.pending()[0]}:\n${diffString(expected, actual)}`

      delete error.config
      delete error.request
      delete error.response
      delete error.status
      delete error.statusCode
      delete error.source

      throw error
    },
    done () {
      assert.ok(api.isDone(), 'Mocks not yet satisfied:\n' + api.pending().join('\n'))
    },
    isDone () {
      return api.pending().length === 0
    }
  }

  return api
}

function getNextMockConfig (mocks) {
  const nextMock = mocks.find(mock => mock.pendingMocks().length > 0).interceptors[0]
  return {
    method: nextMock.method.toLowerCase(),
    url: `https://api.github.com${nextMock.uri}`,
    headers: nextMock.options.reqheaders
  }
}

function applyAdditionsDefault (additions, fixture) {
  merge(fixture, additions)
  if (additions.scope) {
    const url = parseUrl(additions.scope)
    fixture.reqheaders.host = url.host
    if (fixture.headers.location) {
      fixture.headers.location = fixture.headers.location.replace('https://api.github.com/', url.href)
    }
  }

  return fixture
}
