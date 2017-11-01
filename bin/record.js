#!/usr/bin/env node

const axios = require('axios')
const chalk = require('chalk')
const cloneDeep = require('lodash/cloneDeep')
const {diff, diffString} = require('json-diff')
const glob = require('glob')
const humanize = require('humanize-string')

const env = require('../lib/env')
const isTravisCronJob = require('../lib/is-travis-cron-job')
const normalize = require('../lib/normalize')
const notifyAboutFixturesChanges = require('../lib/notify-about-fixtures-changes')
const read = require('../lib/read')
const recordScenario = require('../lib/record-scenario')
const write = require('../lib/write')

const argv = require('minimist')(process.argv.slice(2), {
  boolean: ['update', 'test-cached']
})
const doUpdate = argv.update
const selectedScenarios = argv._
const hasSelectedScenarios = selectedScenarios.length > 0

const scenarios = hasSelectedScenarios ? selectedScenarios : glob.sync('scenarios/**/record.js')
const diffs = []

// run scenarios one by one
scenarios.reduce(async (promise, scenarioPath) => {
  await promise
  const fixtureName = scenarioPath.replace(/(^scenarios\/|\/record\.js$)/g, '')
  const [domain, title] = fixtureName.split('/')
  console.log('')
  console.log(`⏯️  ${chalk.bold(domain)}: ${humanize(title.replace('.js', ''))} ...`)

  let baseURL = `https://${domain}`

  // workaround for https://github.com/octokit/fixtures/issues/3
  if (domain === 'api.github.com' && env.FIXTURES_PROXY) {
    baseURL = env.FIXTURES_PROXY
  }

  const oldNormalizedFixtures = await read(fixtureName)
  const newRawFixtures = await recordScenario({
    request: axios.create({baseURL}),
    scenario: require(`../scenarios/${fixtureName}/record`)
  })

  const scenarioState = {
    commitSha: {} // map original commits to normalized commits
  }

  const newNormalizedFixtures = newRawFixtures
    .map(cloneDeep)
    .filter(hasntIgnoreHeader)
    .map(normalize.bind(null, scenarioState))

  const fixturesDiffs = diff(newNormalizedFixtures, oldNormalizedFixtures)
  if (!fixturesDiffs) {
    console.log(`✅  Fixtures are up-to-date`)
    return
  }

  diffs.push({
    name: fixtureName,
    changes: fixturesDiffs,
    newNormalizedFixtures,
    oldNormalizedFixtures,
    newRawFixtures
  })

  if (fixturesDiffs[0][0] === '-') {
    if (doUpdate) {
      console.log(`📼  New fixtures recorded`)
      return write(fixtureName, {
        normalized: newNormalizedFixtures,
        raw: newRawFixtures
      })
    }
    console.log(`❌  "${fixtureName}" looks like a new fixture`)
    return
  }

  if (doUpdate) {
    console.log(`📼  Fixture updates recorded`)
    return write(fixtureName, {
      normalized: newNormalizedFixtures,
      raw: newRawFixtures
    })
  }

  console.log(`❌  Fixtures are not up-to-date`)

  if (!isTravisCronJob()) {
    console.log(diffString(oldNormalizedFixtures, newNormalizedFixtures))
    console.log(`💁  Update fixtures with \`${chalk.bold('bin/record.js --update')}\``)
  }
}, Promise.resolve())

.then(() => {
  if (diffs.length === 0) {
    if (isTravisCronJob()) {
      console.log('🤖  No fixture changes detected in cron job.')
    }
    return
  }

  if (doUpdate) {
    return
  }

  if (isTravisCronJob()) {
    return notifyAboutFixturesChanges(diffs)
  }

  console.log(`${diffs.length} fixtures are out of date. Exit 1`)
  process.exit(1)
})

.catch((error) => {
  if (!error.response) {
    console.log(error)
    process.exit(1)
  }

  console.log(error.toString())
  console.log(JSON.stringify(error.response.data, null, 2))
  process.exit(1)
})

function hasntIgnoreHeader (fixture) {
  const hasIgnoreHeader = 'x-octokit-fixture-ignore' in fixture.reqheaders
  return !hasIgnoreHeader
}
