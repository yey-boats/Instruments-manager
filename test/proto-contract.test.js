// Contract test: the manager's control-protocol client against the FIRMWARE's
// own protocol artefacts (yey-boats/instruments `proto/` + the generated
// `include/proto/records_generated.h`).
//
// Source of truth:
//   - INSTRUMENTS_DIR=<instruments checkout>  (CI `contract` job checks out
//     yey-boats/instruments main): reads proto/schema, proto/fixtures and the
//     firmware's kProtoMajor straight from the firmware repo.
//   - unset: falls back to the vendored copy in vendor/proto (same layout as
//     instruments/proto), so `npm test` stays hermetic.
//
// What it pins (Instruments-manager#16):
//   1. firmware kProtoMajor == instruments schema x-proto-major == the major
//      the manager speaks (PROTO_VERSION).
//   2. every instruments fixture validates with the manager's validators.
//   3. a handshake against a mock target that applies the firmware's inbound
//      gate (src/web.cpp: 400 {"error":"incompatible_version"} unless the
//      request's major == kProtoMajor) and answers with the fixtures succeeds:
//      describeDevice -> attach -> switch -> detach. Both a record stamped with
//      the firmware major and the record as shipped by firmware v0.4.x
//      (stamped "1.0", see proto-control.js LEGACY_RECORD_MAJORS) must work.
const assert = require('assert')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { ProtoControl, PROTO_VERSION } = require('../lib/proto-control')

const ROOT = process.env.INSTRUMENTS_DIR
  ? path.resolve(process.env.INSTRUMENTS_DIR)
  : null
const PROTO_DIR = ROOT ? path.join(ROOT, 'proto') : path.join(__dirname, '..', 'vendor', 'proto')
const SOURCE = ROOT ? `instruments checkout ${ROOT}` : 'vendored vendor/proto'

function readJson (p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }

function firmwareMajor () {
  const schemaDir = path.join(PROTO_DIR, 'schema')
  const schemas = fs.readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'))
  assert.strictEqual(schemas.length, 1, `exactly one control schema in ${schemaDir}`)
  const schemaMajor = readJson(path.join(schemaDir, schemas[0]))['x-proto-major']
  assert.ok(Number.isInteger(schemaMajor), 'schema declares x-proto-major')
  if (ROOT) {
    const hdr = fs.readFileSync(path.join(ROOT, 'include', 'proto', 'records_generated.h'), 'utf8')
    const m = /kProtoMajor\s*=\s*(\d+)/.exec(hdr)
    assert.ok(m, 'records_generated.h declares kProtoMajor')
    assert.strictEqual(Number(m[1]), schemaMajor,
      'firmware kProtoMajor matches instruments schema x-proto-major')
  }
  return schemaMajor
}

const major = (v) => Number(String(v).split('.')[0])

// Fixture -> validator, keyed on the message `t` (DeviceRecord has none).
const VALIDATOR_BY_T = {
  attach: 'Attach',
  attachAck: 'AttachAck',
  switch: 'Switch',
  switchAck: 'SwitchAck',
  heartbeat: 'Heartbeat',
  detach: 'Detach',
  controlState: 'ControlState'
}

function loadFixtures () {
  const dir = path.join(PROTO_DIR, 'fixtures')
  const out = {}
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    out[f] = readJson(path.join(dir, f))
  }
  return out
}

// Mock target mirroring the firmware's HTTP p2p handlers (instruments
// src/web.cpp handle_p2p_*): every POST is gated on version_compatible(req.v)
// i.e. parsed major == kProtoMajor; replies are the instruments fixtures.
function startFirmwareTarget (fwMajor, fx, deviceRecord) {
  const calls = []
  const gate = (v) => /^\d+\.\d+$/.test(v || '') && major(v) === fwMajor
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const send = (obj, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      calls.push(req.url)
      if (req.method === 'GET' && req.url === '/api/p2p/device') return send(deviceRecord)
      let msg = null
      try { msg = body ? JSON.parse(body) : null } catch (e) { return send({ error: 'bad_json' }, 400) }
      if (!msg || !gate(msg.v)) return send({ error: 'incompatible_version' }, 400)
      if (req.url === '/api/p2p/attach') return send({ ...fx['attach_ack.json'], device: deviceRecord })
      if (req.url === '/api/p2p/switch') return send({ ...fx['switch_ack.json'], currentView: msg.viewId })
      if (req.url === '/api/p2p/detach') return send({ v: fx['switch_ack.json'].v, t: 'detachAck', ok: true })
      send({ error: 'not found' }, 404)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, calls, base: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

async function handshake (fwMajor, fx, deviceRecord, label) {
  const target = await startFirmwareTarget(fwMajor, fx, deviceRecord)
  try {
    const pc = new ProtoControl({ color: '#ff9800' })
    const desc = await pc.describeDevice({ base: target.base })
    assert.strictEqual(desc.ok, true,
      `${label}: describeDevice accepts the firmware DeviceRecord (v=${deviceRecord.v}); got ${desc.reason}`)
    const res = await pc.setScreen({ base: target.base }, 'nav')
    assert.strictEqual(res.ok, true,
      `${label}: attach->switch->detach accepted by the firmware gate (major ${fwMajor}); ` +
      `failed at ${res.stage}: ${res.reason}`)
    assert.strictEqual(res.currentView, 'nav')
    assert.strictEqual(res.detached, true, `${label}: detach accepted`)
    assert.deepStrictEqual(target.calls,
      ['/api/p2p/device', '/api/p2p/attach', '/api/p2p/switch', '/api/p2p/detach'])
  } finally {
    target.server.close()
  }
}

module.exports = (async () => {
  const { validate } = await import('@yeyboats/proto')
  const fwMajor = firmwareMajor()

  // 1. The manager speaks the firmware's major.
  assert.strictEqual(major(PROTO_VERSION), fwMajor,
    `manager PROTO_VERSION ${PROTO_VERSION} speaks the firmware protocol major ${fwMajor} (${SOURCE})`)

  // 2. Every firmware fixture validates with the manager's validators.
  const fx = loadFixtures()
  assert.ok(Object.keys(fx).length > 0, 'instruments fixtures present')
  for (const [name, msg] of Object.entries(fx)) {
    const which = msg.t === undefined ? 'DeviceRecord' : VALIDATOR_BY_T[msg.t]
    assert.ok(which, `fixture ${name}: unknown message type t=${msg.t} (extend VALIDATOR_BY_T)`)
    assert.ok(validate[which](msg), `fixture ${name} validates as ${which} with the manager's validators`)
  }

  // 3. Handshake against the firmware's inbound gate.
  // Upstream fixtures are stamped with the firmware's own version since
  // instruments#25/#26; v0.4.x devices in the field still stamp "1.0", so pin
  // that explicitly to keep LEGACY_RECORD_MAJORS exercised.
  const shipped = fx['device_record.json']
  await handshake(fwMajor, fx, { ...shipped, v: `${fwMajor}.0` }, 'record stamped with firmware major')
  await handshake(fwMajor, fx, { ...shipped, v: '1.0' }, 'record as shipped by firmware v0.4.x')

  console.log(`proto-contract test passed (${SOURCE}, proto major ${fwMajor})`)
})()

if (require.main === module) {
  module.exports.catch((err) => {
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
}
