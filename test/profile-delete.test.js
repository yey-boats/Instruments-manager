'use strict'
const fs = require('node:fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { makeManager, makeSecureManager } = require('./test-utils')
const cloud = require('../lib/cloud-dashboards')
const plugin = require('../index')

function route (manager, method, path) {
  const handlers = []
  const add = (verb) => (p, ...h) => handlers.push({ verb, p, handler: h[h.length - 1] })
  plugin._test.registerRoutes({ use () {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') }, () => manager)
  const found = handlers.find((r) => r.verb === method && r.p === path)
  assert.ok(found, `${method} ${path}`)
  return (id, headers = {}) => new Promise((resolve, reject) => {
    const req = { method, params: { id }, query: {}, body: {}, headers, get: (k) => headers[k.toLowerCase()] || '', socket: { remoteAddress: '127.0.0.1' } }
    const res = { statusCode: 200, headers: {}, setHeader (k, v) { this.headers[k] = v }, status (n) { this.statusCode = n; return this }, json (json) { resolve({ status: this.statusCode, json, headers: this.headers }) }, end (body) { resolve({ status: this.statusCode, body, headers: this.headers }) } }
    Promise.resolve(found.handler(req, res)).catch(reject)
  })
}
function preset (manager, more = {}) {
  return manager.upsertProfile({ id: 'wind', name: 'Wind', config: {}, ...more })
}

test('delete removes only the local preset, persists it, audits it and makes the cloud dashboard importable', async () => {
  const { manager } = makeManager()
  try {
    preset(manager, { source: 'yey.boats', sourceId: 'cloud-wind', sourceUpdatedAt: '2026-11-01' })
    const listing = [{ id: 'cloud-wind', title: 'Wind', updatedAt: '2026-11-01' }]
    assert.equal(cloud.mapListing(listing, manager.listProfiles().profiles)[0].state, 'current')
    const result = await route(manager, 'DELETE', '/profiles/:id')('wind')
    assert.equal(result.status, 200)
    assert.deepEqual(result.json, { id: 'wind', removed: true })
    assert.equal(manager.listProfiles().profiles.some((p) => p.id === 'wind'), false)
    assert.equal(JSON.parse(fs.readFileSync(manager.store.profilesFile)).profiles.wind, undefined)
    assert.match(fs.readFileSync(manager.store.auditFile, 'utf8'), /"type":"profile.deleted"/)
    assert.equal(cloud.mapListing(listing, manager.listProfiles().profiles)[0].state, 'new')
    assert.equal((await route(manager, 'DELETE', '/profiles/:id')('wind')).status, 404)
  } finally { manager.close() }
})

test('assigned presets return 409 with display names and remain until a replacement is assigned', async () => {
  const { manager, auth } = makeManager()
  try {
    preset(manager)
    manager.registerDevice({ device: { id: 'yey-d-helm', name: 'Helm display' } }, auth)
    manager.assignProfile('yey-d-helm', { profileId: 'wind' })
    const del = route(manager, 'DELETE', '/profiles/:id')
    const refused = await del('wind')
    assert.equal(refused.status, 409)
    assert.equal(refused.json.error.code, 'profile_in_use')
    assert.match(refused.json.error.message, /Helm display/)
    assert.deepEqual(refused.json.error.details.devices.map((d) => d.id), ['yey-d-helm'])
    assert.ok(manager.store.profiles.profiles.wind)
    manager.assignProfile('yey-d-helm', { profileId: 'default' })
    const deleted = await route(manager, 'POST', '/ui/profiles/:id/delete')('wind')
    assert.equal(deleted.status, 303)
    assert.match(deleted.headers.location, /ui\/profiles\?status=deleted$/)
  } finally { manager.close() }
})

test('default and built-in presets cannot be deleted', async () => {
  const { manager } = makeManager()
  try {
    preset(manager, { builtin: true })
    for (const id of ['default', 'wind']) {
      const result = await route(manager, 'DELETE', '/profiles/:id')(id)
      assert.equal(result.status, 409)
      assert.equal(result.json.error.code, 'profile_protected')
      assert.ok(manager.store.profiles.profiles[id])
    }
  } finally { manager.close() }
})

test('API and form deletion require an operator and reject cross-origin requests', async () => {
  const { manager } = makeSecureManager()
  try {
    preset(manager)
    for (const [method, path] of [['DELETE', '/profiles/:id'], ['POST', '/ui/profiles/:id/delete']]) {
      const del = route(manager, method, path)
      assert.equal((await del('wind')).status, 401)
      const auth = { 'x-yeyboats-authorization': `Bearer ${manager.apiToken.pendingReveal()}` }
      assert.equal((await del('wind', { ...auth, origin: 'https://evil.example', host: 'boat.local' })).status, 403)
      assert.ok(manager.store.profiles.profiles.wind)
    }
    const result = await route(manager, 'DELETE', '/profiles/:id')('wind', { 'x-yeyboats-authorization': `Bearer ${manager.apiToken.pendingReveal()}` })
    assert.equal(result.status, 200)
  } finally { manager.close() }
})

test('list and detail offer operator deletion with escaped confirmation naming affected displays', () => {
  const { manager, auth } = makeManager()
  try {
    preset(manager, { name: 'Wind "\' <test>' })
    manager.registerDevice({ device: { id: 'yey-d-helm', name: 'Helm <script>' } }, auth)
    manager.assignProfile('yey-d-helm', { profileId: 'wind' })
    for (const page of ['profiles', 'preset']) {
      const html = plugin._test.renderUi(manager, page, { params: { id: 'wind' }, query: {} })
      assert.match(html, /ui\/profiles\/wind\/delete/)
      assert.match(html, /Displays using it: Helm &lt;script&gt;/)
      assert.match(html, /confirm\(this.dataset.confirm\)/)
      assert.doesNotMatch(html, /ui\/profiles\/default\/delete/)
    }
    const { manager: secure } = makeSecureManager()
    try {
      preset(secure)
      assert.doesNotMatch(plugin._test.renderUi(secure, 'profiles', { params: {}, query: {} }), /ui\/profiles\/wind\/delete/)
    } finally { secure.close() }
  } finally { manager.close() }
})
