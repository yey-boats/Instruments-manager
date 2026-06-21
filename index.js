const fs = require('fs')
const path = require('path')
const { YeyBoatsDisplayManager } = require('./lib/manager')
const presets = require('./lib/screen-presets')
const fieldSchema = require('./lib/field-schema')
const pluginPackage = require('./package.json')

module.exports = function yeyBoatsDisplayManagerPlugin (app) {
  let manager

  const plugin = {
    id: 'yey-boats-display-manager',
    name: 'YEY Boats Display Manager',
    description: 'Registry, central configuration, command queue, and firmware management for YEY Boats marine display devices.',
    schema: () => ({
      type: 'object',
      title: 'YEY Boats Display Manager',
      description: 'Open the manager at /yey-boats-display-manager/ or /plugins/yey-boats-display-manager/ui. It is also discoverable from SignalK Admin > Webapps after the server is restarted.',
      properties: {
        links: {
          type: 'object',
          title: 'Operator Links',
          readOnly: true,
          default: {
            webapp: '/yey-boats-display-manager/',
            pluginUi: '/plugins/yey-boats-display-manager/ui',
            devices: '/plugins/yey-boats-display-manager/ui/devices',
            discovery: '/plugins/yey-boats-display-manager/ui/discovery'
          },
          properties: {
            webapp: {
              type: 'string',
              title: 'SignalK webapp',
              default: '/yey-boats-display-manager/'
            },
            pluginUi: {
              type: 'string',
              title: 'Plugin UI',
              default: '/plugins/yey-boats-display-manager/ui'
            },
            devices: {
              type: 'string',
              title: 'Devices',
              default: '/plugins/yey-boats-display-manager/ui/devices'
            },
            discovery: {
              type: 'string',
              title: 'Discovery',
              default: '/plugins/yey-boats-display-manager/ui/discovery'
            }
          }
        },
        serverId: {
          type: 'string',
          title: 'Server ID',
          default: 'yey-boats-display-manager'
        },
        heartbeatMs: {
          type: 'number',
          title: 'Heartbeat interval, ms',
          default: 30000
        },
        commandPollMs: {
          type: 'number',
          title: 'Command poll interval, ms',
          default: 15000
        },
        auth: {
          type: 'object',
          title: 'Authentication',
          properties: {
            mode: {
              type: 'string',
              title: 'Mode',
              enum: ['dev-shared-token', 'provision-token', 'disabled'],
              default: 'dev-shared-token'
            },
            devToken: {
              type: 'string',
              title: 'Development shared token',
              default: 'yeyboats-dev'
            },
            provisionToken: {
              type: 'string',
              title: 'Provisioning token',
              default: 'yeyboats-provision'
            }
          }
        },
        signalk: {
          type: 'object',
          title: 'SignalK Target',
          properties: {
            host: { type: 'string', title: 'Host', default: 'signalk.local' },
            port: { type: 'number', title: 'Port', default: 3000 }
          }
        },
        deviceWebAuth: {
          type: 'object',
          title: 'Device Web API Basic Auth',
          description: 'Credentials pushed to devices and used by this plugin to read live status and logs.',
          properties: {
            enabled: { type: 'boolean', title: 'Enabled', default: true },
            username: { type: 'string', title: 'Username', default: 'yeyboats' },
            password: { type: 'string', title: 'Password', default: 'yeyboats-dev' }
          }
        },
        discoveryUdp: {
          type: 'object',
          title: 'SignalK UDP Discovery',
          description: 'LAN discovery responder used by ESP displays when mDNS is unavailable, for example Docker bridge networking.',
          properties: {
            enabled: { type: 'boolean', title: 'Enabled', default: true },
            bind: { type: 'string', title: 'Bind address', default: '0.0.0.0' },
            port: { type: 'number', title: 'UDP port', default: 34300 },
            host: {
              type: 'string',
              title: 'Advertised host',
              description: 'Leave empty to let the device use the UDP reply source address.',
              default: ''
            }
          }
        },
        deviceDiscoveryUdp: {
          type: 'object',
          title: 'Device UDP Discovery',
          description: 'Listener for ESP display presence announcements. Discovered devices appear in the Discovery page before they are claimed.',
          properties: {
            enabled: { type: 'boolean', title: 'Enabled', default: true },
            bind: { type: 'string', title: 'Bind address', default: '0.0.0.0' },
            port: { type: 'number', title: 'UDP port', default: 34301 }
          }
        },
        firmware: {
          type: 'object',
          title: 'Firmware Catalog',
          properties: {
            github: {
              type: 'object',
              title: 'GitHub release source',
              description: 'Imports firmware artifacts from GitHub release assets for software upgrades.',
              properties: {
                enabled: { type: 'boolean', title: 'Enabled', default: true },
                owner: { type: 'string', title: 'GitHub owner', default: 'yey-boats' },
                repo: { type: 'string', title: 'GitHub repository', default: 'instruments' },
                includePrereleases: { type: 'boolean', title: 'Include prereleases', default: false },
                tipFromArtifacts: {
                  type: 'boolean',
                  title: 'TIP build from CI Actions artifacts',
                  description: 'Import the rolling latest-main "TIP" firmware build from the repo CI workflow Actions artifacts (firmware-<env>-latest) instead of a GitHub release. Requires a token below.',
                  default: true
                },
                token: {
                  type: 'string',
                  title: 'GitHub token (for TIP build)',
                  description: 'Personal Access Token / fine-grained token with Actions:read + Contents:read. REQUIRED to download CI Actions artifacts for the TIP build — GitHub requires authentication to download Actions artifacts even for public repos. Leave empty to disable the TIP-from-artifacts source (tagged releases still import without a token).'
                }
              }
            }
          }
        },
        network: {
          type: 'object',
          title: 'Network Identity',
          properties: {
            domain: { type: 'string', title: 'mDNS domain', default: 'yey.boats' },
            hostnamePrefix: { type: 'string', title: 'Hostname prefix', default: 'yey-d' },
            namingPolicy: {
              type: 'string',
              title: 'Naming policy',
              enum: ['device-id', 'role-location', 'manual'],
              default: 'device-id'
            },
            mdns: {
              type: 'object',
              title: 'mDNS',
              properties: {
                enabled: { type: 'boolean', title: 'Enabled', default: true },
                browser: {
                  type: 'boolean',
                  title: 'Discover ESP displays via Bonjour/mDNS',
                  default: true
                },
                advertiseManager: {
                  type: 'boolean',
                  title: 'Advertise manager via Bonjour/mDNS',
                  default: true
                },
                bind: { type: 'string', title: 'Bind address', default: '0.0.0.0' },
                port: { type: 'number', title: 'mDNS UDP port', default: 5353 },
                advertiseHost: {
                  type: 'string',
                  title: 'Advertised IPv4 address',
                  description: 'Leave empty to use the first non-internal IPv4 address visible to Node.',
                  default: ''
                },
                advertiseIntervalMs: {
                  type: 'number',
                  title: 'Manager advertisement interval, ms',
                  default: 60000
                }
              }
            }
          }
        }
      }
    }),
    start: (options) => {
      manager = new YeyBoatsDisplayManager(app, options || {})
      registerAutopilotBridge(app)
      app.debug('yey-boats-display-manager started')
    },
    stop: () => {
      if (manager && manager.close) manager.close()
      manager = undefined
    },
    statusMessage: () => {
      if (!manager) return 'stopped'
      return `${Object.keys(manager.store.registry.devices).length} device(s)`
    },
    registerWithRouter: (router) => {
      registerRoutes(router, () => manager)
    },
    getOpenApi: () => ({
      openapi: '3.0.0',
      info: {
        title: 'YEY Boats Display Manager',
        version: pluginPackage.version
      },
      paths: {
        '/plugins/yey-boats-display-manager/.well-known/yeyboats-management': {
          get: { summary: 'Discover ESP display management API' }
        },
        '/plugins/yey-boats-display-manager/devices/register': {
          post: { summary: 'Register or refresh an ESP display device' }
        },
        '/plugins/yey-boats-display-manager/discovery/devices': {
          get: { summary: 'List discovered ESP display devices' },
          post: { summary: 'Announce a discovered ESP display device' }
        },
        '/plugins/yey-boats-display-manager/discovery/scan': {
          post: { summary: 'Scan IP or BLE transports for ESP display devices' }
        },
        '/plugins/yey-boats-display-manager/discovery/devices/{deviceId}/claim': {
          post: { summary: 'Claim a discovered ESP display device into the registry' }
        },
        '/plugins/yey-boats-display-manager/capabilities': {
          get: { summary: 'Describe manager protocol capabilities' }
        },
        '/plugins/yey-boats-display-manager/dashboard': {
          get: { summary: 'Summarise managed device health and operations' }
        },
        '/plugins/yey-boats-display-manager/ui': {
          get: { summary: 'Built-in lightweight management console' }
        },
        '/plugins/yey-boats-display-manager/devices/{deviceId}/status': {
          post: { summary: 'Update device status heartbeat' }
        },
        '/plugins/yey-boats-display-manager/devices/{deviceId}/live/status': {
          get: { summary: 'Read live device /api/state' }
        },
        '/plugins/yey-boats-display-manager/devices/{deviceId}/live/logs': {
          get: { summary: 'Read live device /api/logs' }
        },
        '/plugins/yey-boats-display-manager/devices/{deviceId}/config': {
          get: { summary: 'Fetch generated device config' }
        },
        '/plugins/yey-boats-display-manager/devices/{deviceId}/commands': {
          get: { summary: 'Poll pending commands' },
          post: { summary: 'Create a command' }
        },
        '/plugins/yey-boats-display-manager/devices/{deviceId}/commands/{commandId}': {
          get: { summary: 'Read command state' }
        },
        '/plugins/yey-boats-display-manager/provisioning/tokens': {
          get: { summary: 'List provisioning tokens' },
          post: { summary: 'Create provisioning token' }
        },
        '/plugins/yey-boats-display-manager/devices/{deviceId}/profile': {
          post: { summary: 'Assign profile to a device' }
        },
        '/plugins/yey-boats-display-manager/profiles/{profileId}/apply': {
          post: { summary: 'Apply profile to one or more devices' }
        },
        '/plugins/yey-boats-display-manager/groups/{groupId}/command': {
          post: { summary: 'Create command for a device group' }
        },
        '/plugins/yey-boats-display-manager/automation/event': {
          post: { summary: 'Submit automation event' }
        },
        '/plugins/yey-boats-display-manager/firmware/catalog': {
          get: { summary: 'List firmware artifacts' }
        },
        '/plugins/yey-boats-display-manager/firmware/catalog/refresh': {
          post: { summary: 'Refresh firmware artifacts from GitHub releases' }
        },
        '/plugins/yey-boats-display-manager/firmware/targets': {
          get: { summary: 'List firmware target/board/resolution table' }
        },
        '/plugins/yey-boats-display-manager/devices/{deviceId}/firmware/jobs': {
          get: { summary: 'List firmware jobs' },
          post: { summary: 'Create firmware update job' }
        }
      }
    })
  }

  return plugin
}

// Autopilot bridge: the yey-display firmware drives the autopilot the
// signalk-autopilot / spec-16 way (PUT steering.autopilot.state =
// "<mode>", PUT steering.autopilot.actions.adjustHeading = <deg>, PUT
// steering.autopilot.target.headingTrue = <rad>). The KDCube simulator's
// autopilot instead listens for a `steering.autopilot.command` delta
// {action, value, nonce}. This bridge registers PUT handlers for the
// firmware's paths and re-emits them as the sim's command deltas, so the
// device's steering controls drive the modeled boat end-to-end.
function registerAutopilotBridge (app) {
  if (!app || typeof app.registerPutHandler !== 'function') return
  const CMD = 'steering.autopilot.command'
  let seq = 0
  const emit = (action, value) => {
    app.handleMessage('yeyboats-autopilot-bridge', {
      updates: [{
        values: [{ path: CMD, value: { action, value, nonce: `b${++seq}` } }]
      }]
    })
  }
  const done = (cb) => {
    const r = { state: 'COMPLETED', statusCode: 200 }
    if (typeof cb === 'function') cb(r)
    return r
  }
  const reg = (path, fn) => {
    try { app.registerPutHandler('vessels.self', path, fn, 'yeyboats-autopilot-bridge') } catch (e) {
      if (app.debug) app.debug(`autopilot bridge: could not register ${path}: ${e.message}`)
    }
  }
  // Mode: "auto"|"wind"|"route"|"standby" (firmware "track"/"pretrack" -> "route").
  reg('steering.autopilot.state', (ctx, path, value, cb) => {
    let mode = String(value == null ? '' : value).replace(/^"|"$/g, '')
    if (mode === 'track' || mode === 'pretrack') mode = 'route'
    emit('set_mode', mode)
    return done(cb)
  })
  // Heading nudge: firmware sends DEGREES; the sim's "adjust" action expects
  // radians (it converts back to degrees), so scale here.
  reg('steering.autopilot.actions.adjustHeading', (ctx, path, value, cb) => {
    const deg = Number(value) || 0
    emit('adjust', (deg * Math.PI) / 180)
    return done(cb)
  })
  // Absolute target heading (radians, passed through).
  reg('steering.autopilot.target.headingTrue', (ctx, path, value, cb) => {
    emit('set_heading', Number(value) || 0)
    return done(cb)
  })
}

// Apply a list of live-preview field edits onto a profile config, in place.
// Each edit is { widgetId?, screenId, tileIndex, widget, title, unit, precision,
// path, color }. Two shapes:
//   (1) widgetId references an existing widgets.items entry -> rebind in place,
//       round-tripping path + KIND (widget type) + per-element color.
//   (2) no/unknown widgetId -> materialize a stable synthetic widget
//       (w_<screen>_<tileIndex>) and author the screen tile to reference it, so
//       a PRESET grid tile (steering/route/trip/dashboard) edit reaches the
//       device on the next config reload exactly like a Nav tile does.
// Pure over `cfg` (mutates the object it is handed); extracted from the
// save-screen route so the KIND+color round-trip is node-testable.
function applyScreenEdits (cfg, edits) {
  cfg.widgets = cfg.widgets || {}
  cfg.widgets.items = cfg.widgets.items || {}
  const items = cfg.widgets.items
  cfg.layout = cfg.layout || {}
  cfg.layout.screens = Array.isArray(cfg.layout.screens) ? cfg.layout.screens : []
  const screens = cfg.layout.screens
  // Reject keys that are not safe own-property names (blocks
  // __proto__/constructor/prototype prototype-pollution).
  const SAFE_KEY = (k) => typeof k === 'string' && k && !['__proto__', 'constructor', 'prototype'].includes(k)
  // `color` is a map of element->#rrggbb (theme-default when unset).
  // normalizeColor keeps only valid #rrggbb element entries so a cleared swatch
  // persists as "unset" (key dropped) rather than freezing a tile to one theme.
  const HEX = /^#[0-9a-fA-F]{6}$/
  const normalizeColor = (c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null
    const out = {}
    for (const k of Object.keys(c)) {
      if (!SAFE_KEY(k)) continue
      if (typeof c[k] === 'string' && HEX.test(c[k])) out[k] = c[k]
    }
    return Object.keys(out).length ? out : null
  }
  ;(Array.isArray(edits) ? edits : []).forEach((e) => {
    if (!e) return
    // (0) Fullscreen HUD field overrides: a HUD screen has no per-tile slots —
    // it reads a fixed set of LOGICAL fields, each bindable to a SignalK path
    // (+ optional colour). Persist them under the authored screen's config as
    // `hud.fields[key] = {path,color}` so they round-trip to the assigned
    // profile and reload into the editor. (Built-in HUD screens ignore these on
    // the current firmware — preview/stored only; surfaced in the editor note.)
    if (e.hud === true) {
      const sid = typeof e.screenId === 'string' ? e.screenId : null
      if (!sid) return
      const fields = (e.fields && typeof e.fields === 'object' && !Array.isArray(e.fields)) ? e.fields : {}
      const clean = {}
      for (const k of Object.keys(fields)) {
        if (!SAFE_KEY(k)) continue
        const f = fields[k]
        if (!f || typeof f !== 'object') continue
        const entry = {}
        if (typeof f.path === 'string' && f.path.trim()) entry.path = f.path.trim()
        if (typeof f.color === 'string' && HEX.test(f.color)) entry.color = f.color
        if (Object.keys(entry).length) clean[k] = entry
      }
      let scr = screens.find((s) => s && s.id === sid)
      if (!scr) { scr = { id: sid, tiles: [] }; screens.push(scr) }
      if (Object.keys(clean).length) {
        scr.hud = Object.assign({}, scr.hud, { fields: clean })
        if (typeof e.kind === 'string' && e.kind) scr.hud.kind = e.kind
      } else if (scr.hud) {
        // every field reverted to default -> drop the override block entirely.
        delete scr.hud
      }
      return
    }
    const color = normalizeColor(e.color)
    // (1) Authored tile carrying an existing widget key -> rebind in place.
    // Round-trip path + kind (widget type) + color; clear color when the
    // operator unset every element so the tile reverts to theme defaults.
    if (typeof e.widgetId === 'string' && e.widgetId &&
        Object.prototype.hasOwnProperty.call(items, e.widgetId)) {
      const it = items[e.widgetId]
      it.path = String(e.path || '')
      if (typeof e.widget === 'string' && e.widget) it.type = e.widget
      if (color) it.color = color; else delete it.color
      return
    }
    // (2) Preset/managed tile with no own widget key (synthetic id from the
    // preview): materialize a stable widget + author its screen so the rebind
    // actually reaches the device on the next config reload.
    const screenId = typeof e.screenId === 'string' ? e.screenId : null
    const ti = Number.isInteger(e.tileIndex) ? e.tileIndex : null
    if (!screenId || ti == null) return
    const wid = 'w_' + screenId.replace(/[^a-z0-9]+/gi, '_') + '_' + ti
    if (!SAFE_KEY(wid)) return
    // Create/update the widget definition (preserve any prior fields).
    const prev = Object.prototype.hasOwnProperty.call(items, wid) ? items[wid] : {}
    const widget = Object.assign({}, prev, {
      type: e.widget || prev.type || 'numeric',
      title: e.title != null ? e.title : (prev.title || ''),
      path: String(e.path || ''),
      unit: e.unit != null ? e.unit : (prev.unit || ''),
      precision: e.precision != null ? e.precision : (prev.precision != null ? prev.precision : null)
    })
    if (color) widget.color = color; else delete widget.color
    items[wid] = widget
    // Ensure the screen exists in the authored layout and references the widget
    // at its tile slot.
    let scr = screens.find((s) => s && s.id === screenId)
    if (!scr) { scr = { id: screenId, tiles: [] }; screens.push(scr) }
    scr.tiles = Array.isArray(scr.tiles) ? scr.tiles : []
    while (scr.tiles.length <= ti) scr.tiles.push({})
    // Bind the tile to the synthetic widget and drop any stale inline path
    // (primary/path) so the device reads the rebind unambiguously.
    const merged = Object.assign({}, scr.tiles[ti], { widget: wid })
    delete merged.primary
    delete merged.path
    scr.tiles[ti] = merged
  })
  return cfg
}

function registerRoutes (router, getManager) {
  router.use(jsonBody)

  router.get('/.well-known/yeyboats-management', wrap(getManager, (manager, req, res) => {
    res.json(manager.discovery())
  }))

  router.get('/devices', wrap(getManager, (manager, req, res) => {
    res.json(manager.listDevices(req.query || {}))
  }))

  // Lightweight summary list for the Waveshare knob's remote Select-Display
  // menu: [{ id, name, role, online, currentScreen }]. Registered before the
  // ':id' routes so the literal path is matched first.
  router.get('/devices/summary', wrap(getManager, (manager, req, res) => {
    res.json(manager.deviceSummaries())
  }))

  // Views (screens) a device can switch between, for the knob's Select-View
  // menu: { views: [{ id, title }], current }. Derived from the device's
  // resolved layout, falling back to the standard known view ids.
  router.get('/devices/:id/views', wrap(getManager, (manager, req, res) => {
    res.json(manager.deviceViews(req.params.id))
  }))

  // Device-reported capability manifest (ui.capabilities). { capabilities } is
  // null until the device reports one. The layout editor gates its options to
  // this so it only offers what the connected firmware can render.
  router.get('/devices/:id/capabilities', wrap(getManager, (manager, req, res) => {
    res.json({ capabilities: manager.deviceCapabilities(req.params.id) })
  }))

  // ---- Slice 5: manifest-gated layout editor CRUD (JSON) ----------------
  // The field editor (public/field-editor.js) drives these. Each returns the
  // fresh editorLayout { profileId, manifest, screens, items } so the UI can
  // re-render without a second round-trip. Manifest gating + persistence +
  // config.reload all happen in lib/manager.js.

  // Effective manifest the editor gates to (device-reported, or the built-in
  // default when offline / pre-manifest firmware) + the editable layout.
  router.get('/devices/:id/editor/layout', wrap(getManager, (manager, req, res) => {
    res.json(manager.editorLayout(req.params.id))
  }))

  router.post('/devices/:id/editor/screens', wrap(getManager, (manager, req, res) => {
    res.json(manager.addScreen(req.params.id, req.body || {}))
  }))

  router.patch('/devices/:id/editor/screens/:screenId', wrap(getManager, (manager, req, res) => {
    const b = req.body || {}
    if (typeof b.title === 'string') {
      res.json(manager.renameScreen(req.params.id, req.params.screenId, b.title))
    } else {
      res.json(manager.editorLayout(req.params.id))
    }
  }))

  router.post('/devices/:id/editor/screens/reorder', wrap(getManager, (manager, req, res) => {
    res.json(manager.reorderScreens(req.params.id, (req.body && req.body.order) || []))
  }))

  router.delete('/devices/:id/editor/screens/:screenId', wrap(getManager, (manager, req, res) => {
    res.json(manager.deleteScreen(req.params.id, req.params.screenId))
  }))

  router.post('/devices/:id/editor/screens/:screenId/fields', wrap(getManager, (manager, req, res) => {
    res.json(manager.addField(req.params.id, req.params.screenId, (req.body && req.body.field) || {}))
  }))

  router.patch('/devices/:id/editor/screens/:screenId/fields/:widgetId', wrap(getManager, (manager, req, res) => {
    res.json(manager.updateField(req.params.id, req.params.screenId, req.params.widgetId, (req.body && req.body.field) || {}))
  }))

  router.delete('/devices/:id/editor/screens/:screenId/fields/:widgetId', wrap(getManager, (manager, req, res) => {
    res.json(manager.removeField(req.params.id, req.params.screenId, req.params.widgetId))
  }))

  // "Save limits": persist configured range/zones onto the field, and OPTIONALLY
  // write them back to the SignalK path meta (opt-in via writeBack:true). The
  // SK meta write-back degrades gracefully — if SignalK rejects it (no perms),
  // we still persist onto the field and report metaWriteBack:'failed'.
  router.post('/devices/:id/editor/screens/:screenId/fields/:widgetId/limits',
    wrap(getManager, async (manager, req, res) => {
      const b = req.body || {}
      const layout = manager.saveFieldLimits(req.params.id, req.params.screenId, req.params.widgetId, {
        range: b.range, zones: b.zones
      })
      let metaWriteBack = 'skipped'
      if (b.writeBack === true && typeof b.path === 'string' && b.path) {
        metaWriteBack = await writeSignalKMeta(manager, b.path, { range: b.range, zones: b.zones })
          .then(() => 'ok').catch(() => 'failed')
      }
      res.json({ ...layout, metaWriteBack })
    }))

  router.get('/discovery/devices', wrap(getManager, (manager, req, res) => {
    res.json(manager.listDiscoveredDevices())
  }))

  router.post('/discovery/devices', wrap(getManager, (manager, req, res) => {
    res.json(manager.announceDiscoveredDevice(req.body || {}, authFrom(req)))
  }))

  router.post('/discovery/scan', wrap(getManager, async (manager, req, res) => {
    const result = await manager.scanForDevices(req.body || {})
    if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
      res.statusCode = 303
      res.setHeader('location', `/plugins/yey-boats-display-manager/ui/discovery?scan=${encodeURIComponent(result.status)}&found=${result.found}&scanned=${result.scanned}`)
      res.end()
      return
    }
    res.json(result)
  }))

  router.post('/devices/register-from-signalk', wrap(getManager, async (manager, req, res) => {
    const body = req.body || {}
    const result = await manager.registerDeviceFromSignalK({
      ...body,
      sendReload: checkboxValue(body.sendReload),
      sendManagerRegister: checkboxValue(body.sendManagerRegister)
    })
    if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
      res.statusCode = 303
      res.setHeader('location', `/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(result.deviceId)}?status=registered-through-signalk`)
      res.end()
      return
    }
    res.json(result)
  }))

  router.post('/discovery/devices/:id/claim', wrap(getManager, (manager, req, res) => {
    const body = req.body || {}
    const result = manager.claimDiscoveredDevice(req.params.id, {
      ...body,
      sendReload: checkboxValue(body.sendReload),
      issueToken: checkboxValue(body.issueToken)
    })
    if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
      res.statusCode = 303
      res.setHeader('location', `/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(req.params.id)}`)
      res.end()
      return
    }
    res.json(result)
  }))

  router.get('/capabilities', wrap(getManager, (manager, req, res) => {
    res.json(manager.pluginCapabilities())
  }))

  // ---- screen-preset catalogue (read-only) ------------------------------
  // Powers the visual layout editor: GET /presets/screens?board=<id> (or
  // ?displayClass=<id>) returns a curated list of starter screens that
  // match the device's display geometry. The editor inserts the chosen
  // screen verbatim into the active profile.
  router.get('/presets/displays', (req, res) => {
    res.json({ displayClasses: presets.listDisplayClasses() })
  })
  router.get('/presets/widgets', (req, res) => {
    res.json({ widgetTypes: presets.listWidgetTypes(), paths: presets.ALL_PATHS })
  })
  router.get('/presets/screens', (req, res) => {
    const displayClass = req.query.displayClass ||
                        (req.query.board ? presets.classifyBoard(String(req.query.board)) : 'sunton-480')
    res.json({
      displayClass,
      screens: presets.getPresetsForClass(String(displayClass))
    })
  })

  // GET /devices/proxy/screenshot.png?url=http://<device-host>[:port]
  //
  // Pulls /api/screenshot.png from the device and streams the body back
  // to the editor. Lets the layout-editor UI work even when the browser
  // can't directly reach the device (e.g. browser on a different VLAN
  // than the device, but the SignalK host can route to both).
  //
  // Allows only http/https URLs to private-network targets (RFC 1918 +
  // link-local + loopback). No public-internet SSRF.
  function isPrivateHost (host) {
    if (!host) return false
    if (host === 'localhost' || host.endsWith('.local')) return true
    const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
    if (!v4) return false
    const o = v4.slice(1, 5).map((n) => parseInt(n, 10))
    if (o.some((x) => isNaN(x) || x < 0 || x > 255)) return false
    if (o[0] === 10) return true
    if (o[0] === 192 && o[1] === 168) return true
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true
    if (o[0] === 169 && o[1] === 254) return true
    if (o[0] === 127) return true
    return false
  }
  router.get('/devices/proxy/screenshot.png', async (req, res) => {
    try {
      const raw = String(req.query.url || '').trim()
      if (!raw) { res.status(400).json({ error: 'missing url' }); return }
      const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'http://' + raw)
      if (!/^https?:$/i.test(u.protocol)) {
        res.status(400).json({ error: 'unsupported scheme' })
        return
      }
      if (!isPrivateHost(u.hostname)) {
        res.status(403).json({ error: 'only private-network hosts allowed' })
        return
      }
      // node 18+ has global fetch; SignalK ships node 20.
      // redirect: 'manual' prevents an attacker-controlled device from
      // 302'ing this server-side fetch to an arbitrary host (the
      // private-host check above only validates the URL we typed,
      // not what the device might redirect us to).
      const upstream = await fetch(u.origin + '/api/screenshot.png', {
        signal: AbortSignal.timeout(10000),
        redirect: 'manual'
      })
      if (upstream.status >= 300 && upstream.status < 400) {
        res.status(502).json({ error: 'device tried to redirect; refusing' })
        return
      }
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: 'device returned ' + upstream.status })
        return
      }
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', 'no-store')
      // No CORS wildcard: the editor reaches this proxy same-origin
      // (it's mounted under /plugins/yey-boats-display-manager). Cross-origin
      // callers should not be able to use the SignalK host as an open
      // SSRF gateway into the LAN.
      const buf = Buffer.from(await upstream.arrayBuffer())
      res.end(buf)
    } catch (e) {
      res.status(502).json({ error: e.message || String(e) })
    }
  })

  router.get('/dashboard', wrap(getManager, (manager, req, res) => {
    res.json(manager.dashboard())
  }))

  router.get('/ui', wrap(getManager, (manager, req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    // Overview merged into the devices home page; nav highlights "Devices".
    res.end(renderUi(manager, 'devices', req))
  }))

  router.get('/ui/devices', wrap(getManager, (manager, req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(renderUi(manager, 'devices', req))
  }))

  router.get('/ui/devices/:id', wrap(getManager, (manager, req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    const dashboard = manager.dashboard()
    // Render immediately with placeholder live sections; the browser lazy-loads
    // live status + logs from the *-fragment endpoints after DOMContentLoaded so
    // a slow/offline device never blocks (or hangs) the page render.
    const selScreen = req.query && req.query.screen ? String(req.query.screen) : null
    res.end(renderUiShell('Device detail', renderDevicePage(manager, req.params.id, {}, { selectScreen: selScreen }), dashboard, 'device'))
  }))

  // The config page was merged into the device detail page as a collapsed
  // <details id="config"> section. This route is kept as a backstop so old
  // links/bookmarks keep working: redirect to the unified page anchored at the
  // config section (which opens itself when navigated to via #config).
  router.get('/ui/devices/:id/config', wrap(getManager, (manager, req, res) => {
    res.statusCode = 302
    res.setHeader('location', `/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(req.params.id)}#config`)
    res.end()
  }))

  router.get('/ui/devices/:id/live/status', wrap(getManager, async (manager, req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    try {
      const status = await manager.getLiveStatus(req.params.id)
      res.end(renderLiveStatusPage(manager, req.params.id, status))
    } catch (err) {
      res.end(renderLiveErrorPage(manager, req.params.id, 'Live status', err))
    }
  }))

  router.get('/ui/devices/:id/live/logs', wrap(getManager, async (manager, req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    try {
      const logs = await manager.getLiveLogs(req.params.id, req.query.since)
      res.end(renderLiveLogsPage(manager, req.params.id, logs))
    } catch (err) {
      res.end(renderLiveErrorPage(manager, req.params.id, 'Live logs', err))
    }
  }))

  // Fragment endpoints: return ONLY the live widget HTML (reusing the same
  // renderLiveStatusWidget / renderLiveLogsWidget builders the page used to
  // embed) so the device page can lazy-load them client-side into placeholders
  // without duplicating widget markup. These do the (slow) device round-trip
  // that the device page no longer blocks on.
  router.get('/ui/devices/:id/live/status-fragment', wrap(getManager, async (manager, req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    try {
      const status = await manager.getLiveStatus(req.params.id)
      res.end(renderLiveStatusWidget(status))
    } catch (err) {
      res.end(renderLiveStatusWidget(undefined, err))
    }
  }))

  router.get('/ui/devices/:id/live/logs-fragment', wrap(getManager, async (manager, req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    try {
      const logs = await manager.getLiveLogs(req.params.id, req.query.since)
      res.end(renderLiveLogsWidget(logs))
    } catch (err) {
      res.end(renderLiveLogsWidget(undefined, err))
    }
  }))

  router.post('/ui/devices/:id/config', wrap(getManager, (manager, req, res) => {
    const result = saveDeviceConfigForm(manager, req.params.id, req.body || {})
    res.statusCode = 303
    res.setHeader('location', `/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(req.params.id)}?status=${encodeURIComponent(result.status)}#config`)
    res.end()
  }))

  router.get('/ui/discovery', wrap(getManager, (manager, req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(renderUi(manager, 'devices', req))
  }))

  // Cleanup endpoints: device removal + artifact removal. JSON for
  // automation, form-redirect for the UI buttons.
  router.delete('/devices/:id', wrap(getManager, (manager, req, res) => {
    res.json(manager.deleteDevice(req.params.id))
  }))
  router.post('/ui/devices/:id/delete', wrap(getManager, (manager, req, res) => {
    manager.deleteDevice(req.params.id)
    res.statusCode = 303
    res.setHeader('location', '/plugins/yey-boats-display-manager/ui/devices')
    res.end()
  }))
  // Bulk cleanup of the registered-devices list.
  router.post('/ui/devices/clear-offline', wrap(getManager, (manager, req, res) => {
    const r = manager.deleteOfflineDevices()
    res.statusCode = 303
    res.setHeader('location', `/plugins/yey-boats-display-manager/ui/devices?cleared=offline&removed=${r.removed}`)
    res.end()
  }))
  router.post('/ui/devices/clear-all', wrap(getManager, (manager, req, res) => {
    const r = manager.clearAllDevices()
    res.statusCode = 303
    res.setHeader('location', `/plugins/yey-boats-display-manager/ui/devices?cleared=all&removed=${r.removed}`)
    res.end()
  }))
  router.delete('/firmware/artifacts/:artifactId', wrap(getManager, (manager, req, res) => {
    res.json(manager.deleteFirmwareArtifact(req.params.artifactId))
  }))
  router.post('/ui/firmware/artifacts/:artifactId/delete', wrap(getManager, (manager, req, res) => {
    manager.deleteFirmwareArtifact(req.params.artifactId)
    res.statusCode = 303
    res.setHeader('location', '/plugins/yey-boats-display-manager/ui/firmware')
    res.end()
  }))

  router.get('/ui/profiles', wrap(getManager, (manager, req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(renderUi(manager, 'profiles', req))
  }))

  // Layout editor lives in public/layout-editor.html. We serve it
  // inside the standard renderUiShell so the nav stays consistent
  // and operators see the same header/links as on every other page.
  // The editor iframe stretches to fill the panel; the editor itself
  // owns its own toolbar inside that.
  router.get('/ui/layout', wrap(getManager, (manager, req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    const dashboard = manager.dashboard()
    const body = `
      <section class="panel" style="padding: 0; overflow: hidden;">
        <iframe src="/yey-boats-display-manager/layout-editor.html"
                style="width: 100%; height: calc(100vh - 220px); border: 0; display: block;"
                title="Layout editor"></iframe>
      </section>`
    res.end(renderUiShell('Layout editor', body, dashboard, 'layout'))
  }))

  // MIDL instruments demo: a self-contained page (public/instruments.html +
  // instruments.js) that renders a library MIDL dashboard live against the
  // SignalK feed via the shared @yey-boats/midl-web device bundle. It is served
  // statically as part of the webapp; this is a convenience redirect to it.
  router.get('/instruments', (req, res) => {
    res.statusCode = 302
    res.setHeader('location', '/yey-boats-display-manager/instruments.html')
    res.end()
  })

  router.get('/ui/profiles/:id', wrap(getManager, (manager, req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(renderUi(manager, 'preset', req))
  }))

  router.post('/ui/profiles/:id/apply', wrap(getManager, (manager, req, res) => {
    const result = applyPresetForm(manager, req.params.id, req.body || {})
    res.statusCode = 303
    res.setHeader('location', `/plugins/yey-boats-display-manager/ui/profiles/${encodeURIComponent(req.params.id)}?status=${encodeURIComponent(result.status)}&count=${result.count}`)
    res.end()
  }))

  // Switch a single device to a selected view/profile and queue config.reload.
  router.post('/ui/devices/:id/switch-view', wrap(getManager, (manager, req, res) => {
    const profileId = (req.body && req.body.profileId) || 'default'
    const result = applyPresetForm(manager, profileId, {
      deviceIds: [req.params.id],
      clearOverrides: 'on',
      sendReload: 'on'
    })
    res.statusCode = 303
    res.setHeader('location',
      `/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(req.params.id)}` +
      `?status=${encodeURIComponent(result.status)}`)
    res.end()
  }))

  // Switch a single device to a specific screen (live), without changing its
  // assigned profile. Queues a `screen.set` command (createCommand also drives
  // the control-protocol path directly when the device speaks it); the firmware
  // maps screen.set -> show_by_id on its next command poll.
  router.post('/ui/devices/:id/switch-screen', wrap(getManager, (manager, req, res) => {
    const screenId = (req.body && req.body.screenId) || ''
    let status = 'no-screen'
    if (screenId) {
      manager.createCommand(req.params.id, { type: 'screen.set', payload: { screen: screenId } })
      status = 'screen-set'
    }
    res.statusCode = 303
    res.setHeader('location',
      `/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(req.params.id)}` +
      `?status=${encodeURIComponent(status)}`)
    res.end()
  }))

  // Save edited data-field bindings from the live preview. mode=switch queues a
  // screen.set; mode=update rewrites the assigned profile's widget paths and
  // reloads the device; mode=create saves the edited layout as a new profile.
  router.post('/ui/devices/:id/save-screen', wrap(getManager, (manager, req, res) => {
    const id = req.params.id
    const body = req.body || {}
    const mode = body.mode || 'update'
    let edits = []
    try { edits = JSON.parse(body.edits || '[]') } catch (e) { edits = [] }
    let status = 'noop'
    // AJAX clients (the live preview's "Show on device") set ajax=1 / send an
    // Accept: application/json header so we answer with JSON instead of a 303
    // full-page reload — that keeps the operator's selected preview screen put.
    const wantsJson = body.ajax === '1' || body.ajax === 1 ||
      /application\/json/.test(String(req.headers && req.headers.accept))
    if (mode === 'switch') {
      if (body.screenId) {
        manager.createCommand(id, { type: 'screen.set', payload: { screen: body.screenId } })
        status = 'switched'
      }
      if (wantsJson) {
        res.json({ status, screenId: body.screenId || null })
        return
      }
    } else {
      const device = manager.getDevice(id)
      const baseId = device.assignedProfile || 'default'
      const base = manager.store.profiles.profiles[baseId]
      if (base) {
        const cfg = JSON.parse(JSON.stringify(base.config || {}))
        applyScreenEdits(cfg, edits)
        if (mode === 'create') {
          const name = String(body.profileName || 'New View').trim()
          const newId = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')) ||
            ('view-' + Math.abs(sha256Json({ id, t: cfg }).length))
          manager.upsertProfile({ id: newId, name, config: cfg })
          status = 'created:' + newId
        } else {
          manager.upsertProfile({ id: baseId, name: base.name || baseId, config: cfg })
          try { manager.queueConfigReload(id) } catch (e) {}
          status = 'updated'
        }
      }
    }
    if (wantsJson) {
      res.json({ status, screenId: body.screenId || null })
      return
    }
    // Carry the operator's selected preview screen through the redirect so the
    // dropdown pre-selects it after the full-page reload (no snapping back to
    // the default screen).
    const scr = body.screenId ? `&screen=${encodeURIComponent(body.screenId)}` : ''
    res.statusCode = 303
    res.setHeader('location',
      `/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(id)}?status=${encodeURIComponent(status)}${scr}`)
    res.end()
  }))

  router.get('/ui/firmware', wrap(getManager, (manager, req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(renderUi(manager, 'firmware', req))
  }))

  router.get('/ui/settings', wrap(getManager, (manager, req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(renderUiShell('Settings', renderSettingsPage(manager, req), manager.dashboard(), 'settings'))
  }))

  router.post('/ui/settings', wrap(getManager, (manager, req, res) => {
    const b = req.body || {}
    manager.updateSettings({
      network: { ssid: b.ssid, mdnsDomain: b.mdnsDomain, password: b.network_password || '' },
      ota: { password: b.ota_password || '' },
      numbering: { prefix: b.prefix, pad: b.pad != null && b.pad !== '' ? parseInt(b.pad, 10) : undefined, next: b.next != null && b.next !== '' ? parseInt(b.next, 10) : undefined }
    })
    res.statusCode = 303
    res.setHeader('location', '/plugins/yey-boats-display-manager/ui/settings?saved=1')
    res.end()
  }))

  router.post('/ui/firmware/catalog/refresh', wrap(getManager, async (manager, req, res) => {
    await manager.refreshFirmwareFromGithub()
    await manager.refreshTipFromArtifacts().catch(() => {})
    res.statusCode = 303
    res.setHeader('location', '/plugins/yey-boats-display-manager/ui/firmware')
    res.end()
  }))

  router.post('/ui/devices/:id/firmware/update', wrap(getManager, (manager, req, res) => {
    manager.createFirmwareJob(req.params.id, {
      artifactId: req.body && req.body.artifactId,
      policy: {
        reboot: req.body.reboot !== 'false',
        confirmAfterBoot: req.body.confirmAfterBoot !== 'false',
        rollbackOnFailure: true
      }
    })
    res.statusCode = 303
    res.setHeader('location', '/plugins/yey-boats-display-manager/ui/firmware')
    res.end()
  }))

  router.get('/groups', wrap(getManager, (manager, req, res) => {
    res.json(manager.listGroups())
  }))

  router.get('/provisioning/tokens', wrap(getManager, (manager, req, res) => {
    res.json(manager.listProvisioningTokens())
  }))

  router.post('/provisioning/tokens', wrap(getManager, (manager, req, res) => {
    res.json(manager.createProvisioningToken(req.body || {}))
  }))

  router.post('/devices/register', wrap(getManager, (manager, req, res) => {
    res.json(manager.registerDevice(req.body || {}, authFrom(req)))
  }))

  router.get('/devices/:id', wrap(getManager, (manager, req, res) => {
    res.json(manager.getDevice(req.params.id))
  }))

  router.patch('/devices/:id', wrap(getManager, (manager, req, res) => {
    res.json(manager.patchDevice(req.params.id, req.body || {}))
  }))

  router.get('/devices/:id/auth/status', wrap(getManager, (manager, req, res) => {
    res.json(manager.authStatus(req.params.id))
  }))

  router.post('/devices/:id/profile', wrap(getManager, (manager, req, res) => {
    res.json(manager.assignProfile(req.params.id, req.body || {}))
  }))

  router.post('/devices/:id/status', wrap(getManager, (manager, req, res) => {
    res.json(manager.updateStatus(req.params.id, req.body || {}, authFrom(req)))
  }))

  router.get('/devices/:id/live/status', wrap(getManager, async (manager, req, res) => {
    res.json(await manager.getLiveStatus(req.params.id))
  }))

  router.get('/devices/:id/live/logs', wrap(getManager, async (manager, req, res) => {
    res.json(await manager.getLiveLogs(req.params.id, req.query.since))
  }))

  router.get('/devices/:id/config', wrap(getManager, (manager, req, res) => {
    manager.requireDeviceAuth(req.params.id, authFrom(req))
    res.json(manager.generateConfig(req.params.id))
  }))

  router.get('/profiles', wrap(getManager, (manager, req, res) => {
    res.json(manager.listProfiles())
  }))

  router.get('/profiles/:id/dashboard.json', wrap(getManager, (manager, req, res) => {
    res.json(dashboardPresetDocument(manager, req.params.id))
  }))

  router.get('/profiles/:id/dashboard.yaml', wrap(getManager, (manager, req, res) => {
    res.setHeader('content-type', 'application/yaml; charset=utf-8')
    res.end(toYaml(dashboardPresetDocument(manager, req.params.id)))
  }))

  router.post('/profiles/import-dashboard', wrap(getManager, (manager, req, res) => {
    const imported = importDashboardPreset(manager, req.body || {}, req.headers || {})
    if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
      res.statusCode = 303
      res.setHeader('location', `/plugins/yey-boats-display-manager/ui/profiles/${encodeURIComponent(imported.id)}`)
      res.end()
      return
    }
    const midlValidation = require('./lib/midl').validateV2AsMidl(imported.config)
    res.json(Object.assign({}, imported, { midlValidation }))
  }))

  router.post('/profiles', wrap(getManager, (manager, req, res) => {
    res.json(manager.upsertProfile(req.body || {}))
  }))

  router.post('/profiles/:id/apply', wrap(getManager, (manager, req, res) => {
    res.json(manager.applyProfile(req.params.id, req.body || {}))
  }))

  router.post('/devices/:id/command', wrap(getManager, (manager, req, res) => {
    res.json(manager.createCommand(req.params.id, req.body || {}))
  }))

  router.post('/groups/:groupId/command', wrap(getManager, (manager, req, res) => {
    res.json(manager.createGroupCommand(req.params.groupId, req.body || {}))
  }))

  router.post('/automation/event', wrap(getManager, (manager, req, res) => {
    res.json(manager.automationEvent(req.body || {}))
  }))

  router.get('/devices/:id/commands', wrap(getManager, (manager, req, res) => {
    res.json(manager.getCommands(req.params.id, authFrom(req), req.query.limit))
  }))

  router.get('/devices/:id/commands/:commandId', wrap(getManager, (manager, req, res) => {
    res.json(manager.getCommand(req.params.id, req.params.commandId))
  }))

  router.post('/devices/:id/commands/:commandId/cancel', wrap(getManager, (manager, req, res) => {
    res.json(manager.cancelCommand(req.params.id, req.params.commandId, (req.body || {}).reason))
  }))

  router.post('/devices/:id/commands/:commandId/ack', wrap(getManager, (manager, req, res) => {
    res.json(manager.ackCommand(req.params.id, req.params.commandId, req.body || {}, authFrom(req)))
  }))

  router.post('/devices/:id/tokens/rotate', wrap(getManager, (manager, req, res) => {
    res.json(manager.rotateDeviceToken(req.params.id))
  }))

  router.post('/devices/:id/tokens/revoke', wrap(getManager, (manager, req, res) => {
    res.json(manager.revokeDeviceToken(req.params.id))
  }))

  router.get('/firmware/catalog', wrap(getManager, (manager, req, res) => {
    res.json(manager.listFirmware())
  }))

  // Server-sourced provisioning payload for the browser WebSerial flow
  // (public/provision.js). Returns only the WiFi credentials needed for the
  // serial bootstrap. OTA password and device number are NEVER returned here:
  //   - OTA password must not transit the client (applied server-side via
  //     config-push, Slice 7, once the device registers).
  //   - Device number is assigned server-side at registration, not on payload
  //     fetch (a plain GET/prefetch/reload must not burn device numbers).
  // Every /plugins/yey-boats-display-manager route is behind the SignalK session.
  // Do not add CORS; do not log the secrets.
  router.get('/provisioning/payload', wrap(getManager, (manager, req, res) => {
    const s = manager.getSettings()
    res.json({ wifi: { ssid: s.network.ssid, password: s.network.password, mdnsDomain: s.network.mdnsDomain } })
  }))

  router.post('/firmware/catalog/refresh', wrap(getManager, async (manager, req, res) => {
    const result = await manager.refreshFirmwareFromGithub()
    await manager.refreshTipFromArtifacts().catch(() => {})
    res.json(manager.listFirmware ? { ...result, ...manager.listFirmware() } : result)
  }))

  router.post('/firmware/artifacts', wrap(getManager, (manager, req, res) => {
    res.json(manager.addFirmwareArtifact(req.body || {}))
  }))

  router.get('/firmware/artifacts/:artifactId', wrap(getManager, (manager, req, res) => {
    res.json(manager.getFirmwareArtifact(req.params.artifactId))
  }))

  router.get('/firmware/manifest/:artifactId', wrap(getManager, (manager, req, res) => {
    const man = manager.firmwareManifest(req.params.artifactId)
    if (!man) {
      res.status(404).json({ error: { code: 'artifact_not_found' } })
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(man))
  }))

  // esp-web-tools (browser USB flasher) streams the binary from this
  // same-origin route. Local uploads have file.path; GitHub artifacts only
  // have file.url, so firmwareArtifactBinary downloads-on-demand into a
  // sha-verified local cache, then we stream that — flashing stays
  // browser-local, GitHub is never proxied through the device/network.
  router.get('/firmware/artifacts/:artifactId/binary', wrap(getManager, async (manager, req, res) => {
    const file = await manager.firmwareArtifactBinary(req.params.artifactId)
    if (!file) {
      res.status(404).json({ error: { code: 'artifact_binary_missing' } })
      return
    }
    res.setHeader('content-type', file.contentType || 'application/octet-stream')
    if (file.size) res.setHeader('content-length', String(file.size))
    res.setHeader('content-disposition', `attachment; filename="${path.basename(file.name || file.path)}"`)
    fs.createReadStream(file.path)
      .on('error', (err) => {
        if (!res.headersSent) {
          res.status(404).json({ error: { code: 'artifact_binary_missing', message: err.message } })
        } else {
          res.destroy(err)
        }
      })
      .pipe(res)
  }))

  router.get('/firmware/targets', wrap(getManager, (manager, req, res) => {
    res.json(manager.firmwareTargets())
  }))

  router.get('/firmware/download/:jobId', wrap(getManager, async (manager, req, res) => {
    const info = manager.firmwareDownloadInfo(req.params.jobId)
    // The device pulls this over plain LAN HTTP; authorize with the same
    // device token it uses for /commands (scoped to this job's device).
    manager.requireDeviceAuth(info.job.deviceId, authFrom(req))
    const file = info.artifact && info.artifact.file ? info.artifact.file : {}
    if (!file.path) {
      // No local copy (GitHub-release artifact): the manager (host) fetches
      // the asset over HTTPS, following redirects, and streams it to the
      // device over HTTP — so the heap-constrained device never does TLS.
      if (file.url) {
        const upstream = await fetch(file.url, { redirect: 'follow' })
        if (!upstream.ok) {
          res.status(502).json({ error: { code: 'upstream_fetch_failed', message: `upstream GET ${upstream.status}` } })
          return
        }
        const body = Buffer.from(await upstream.arrayBuffer())
        res.setHeader('content-type', file.contentType || 'application/octet-stream')
        res.setHeader('content-length', String(body.length))
        res.setHeader('x-yeyboats-artifact-id', info.artifact.artifactId)
        res.setHeader('x-yeyboats-sha256', file.sha256 || '')
        res.end(body)
        return
      }
      res.json(info)
      return
    }
    res.setHeader('content-type', file.contentType || 'application/octet-stream')
    if (file.size) res.setHeader('content-length', String(file.size))
    res.setHeader('x-yeyboats-artifact-id', info.artifact.artifactId)
    res.setHeader('x-yeyboats-sha256', file.sha256 || '')
    res.setHeader('content-disposition', `attachment; filename="${path.basename(file.name || file.path)}"`)
    fs.createReadStream(file.path)
      .on('error', (err) => {
        if (!res.headersSent) {
          res.status(404).json({ error: { code: 'artifact_binary_missing', message: err.message } })
        } else {
          res.destroy(err)
        }
      })
      .pipe(res)
  }))

  router.get('/devices/:id/firmware/jobs', wrap(getManager, (manager, req, res) => {
    res.json(manager.listFirmwareJobs(req.params.id))
  }))

  router.post('/devices/:id/firmware/jobs', wrap(getManager, (manager, req, res) => {
    res.json(manager.createFirmwareJob(req.params.id, req.body || {}))
  }))

  router.get('/devices/:id/firmware/jobs/:jobId', wrap(getManager, (manager, req, res) => {
    res.json(manager.getFirmwareJob(req.params.id, req.params.jobId))
  }))

  router.post('/devices/:id/firmware/jobs/:jobId/progress', wrap(getManager, (manager, req, res) => {
    res.json(manager.updateFirmwareProgress(req.params.id, req.params.jobId, req.body || {}, authFrom(req)))
  }))

  router.post('/devices/:id/firmware/confirm', wrap(getManager, (manager, req, res) => {
    res.json(manager.confirmFirmware(req.params.id, req.body || {}, authFrom(req)))
  }))
}

function wrap (getManager, handler) {
  return (req, res) => {
    try {
      const manager = getManager()
      if (!manager) {
        res.status(503).json({ error: { code: 'plugin_stopped', message: 'plugin is not running' } })
        return
      }
      Promise.resolve(handler(manager, req, res)).catch((err) => {
        const status = err.status || 500
        res.status(status).json(err.payload || {
          error: {
            code: status === 500 ? 'internal_error' : 'request_failed',
            message: err.message
          }
        })
      })
    } catch (err) {
      const status = err.status || 500
      res.status(status).json(err.payload || {
        error: {
          code: status === 500 ? 'internal_error' : 'request_failed',
          message: err.message
        }
      })
    }
  }
}

function authFrom (req) {
  const value = (req.get && req.get('x-yeyboats-authorization')) ||
    (req.headers && req.headers['x-yeyboats-authorization']) ||
    (req.get ? req.get('authorization') : (req.headers.authorization || ''))
  const match = String(value || '').match(/^Bearer\s+(.+)$/i)
  const provision = String(value || '').match(/^YeyBoats-Provision\s+(.+)$/i)
  return {
    bearer: match ? match[1] : null,
    provision: provision ? provision[1] : null
  }
}

function jsonBody (req, res, next) {
  if (req.body || req.method === 'GET' || req.method === 'HEAD') {
    next()
    return
  }
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => {
    body += chunk
    if (body.length > 1024 * 1024) req.destroy()
  })
  req.on('end', () => {
    if (!body) {
      req.body = {}
    } else {
      try {
        const contentType = req.headers['content-type'] || ''
        if (contentType.includes('application/x-www-form-urlencoded')) {
          req.body = parseUrlEncodedForm(body)
        } else if (contentType.includes('yaml') || contentType.includes('text/plain')) {
          req.body = { raw: body }
        } else {
          req.body = JSON.parse(body)
        }
      } catch (err) {
        res.status(400).json({ error: { code: 'invalid_body', message: 'invalid request body' } })
        return
      }
    }
    next()
  })
}

function parseUrlEncodedForm (body) {
  const parsed = {}
  for (const [key, value] of new URLSearchParams(body)) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      parsed[key] = Array.isArray(parsed[key])
        ? parsed[key].concat(value)
        : [parsed[key], value]
    } else {
      parsed[key] = value
    }
  }
  return parsed
}

function dashboardPresetDocument (manager, profileId) {
  const profile = manager.store.profiles.profiles[profileId]
  if (!profile) throw statusError(404, 'preset not found')
  return {
    kind: 'yeyboats.dashboard.v2',
    preset: {
      id: profile.id,
      name: profile.name || profile.id,
      version: Number(profile.version || 1),
      updatedAt: profile.updatedAt || null
    },
    dashboard: profile.config || {}
  }
}

function importDashboardPreset (manager, body, headers) {
  const contentType = String(headers['content-type'] || '')
  const doc = body.raw
    ? parseDashboardImport(body.raw, body.format === 'json' ? 'application/json' : contentType)
    : (body.dashboard || body.preset ? body : { dashboard: body })
  if (doc.kind && doc.kind !== 'yeyboats.dashboard.v2') {
    throw statusError(400, 'unsupported dashboard config kind')
  }
  const preset = doc.preset || {}
  const id = sanitizePresetId(body.presetId || doc.presetId || preset.id || preset.name)
  if (!id) throw statusError(400, 'preset id is required')
  const config = doc.dashboard || doc.config
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw statusError(400, 'dashboard object is required')
  }
  return manager.upsertProfile({
    id,
    name: preset.name || doc.name || id,
    version: Number(preset.version || doc.version || 1),
    config
  })
}

function parseDashboardImport (raw, contentType) {
  const text = String(raw || '').trim()
  if (!text) throw statusError(400, 'empty dashboard import')
  if (contentType.includes('json') || text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text)
    } catch (err) {
      throw statusError(400, 'invalid dashboard JSON')
    }
  }
  return fromYaml(text)
}

function renderUi (manager, page, req) {
  const dashboard = manager.dashboard()
  const title = {
    devices: 'Devices',
    device: 'Device detail',
    deviceConfig: 'Device config',
    discovery: 'Discovery',
    profiles: 'Profiles',
    preset: 'Preset',
    firmware: 'Firmware',
    settings: 'Settings'
  }[page] || 'Overview'
  return renderUiShell(title, renderPage(manager, dashboard, page, req), dashboard, page)
}

function renderUiShell (title, body, dashboard, page = '') {
  dashboard = dashboard || { serverId: 'yey-boats-display-manager', generatedAt: new Date().toISOString() }
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YEY Boats Display Manager · ${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { max-width: 100%; overflow-x: hidden; }
    body { margin: 0; background: #f5f7f8; color: #172026; }
    header { padding: 18px 28px 0; background: #15323b; color: white; }
    main { padding: 24px 28px; }
    h1 { margin: 0; font-size: 24px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    .sub { color: #d6e2e6; margin-top: 4px; padding-bottom: 14px; }
    nav { display: flex; gap: 4px; flex-wrap: wrap; }
    nav a { color: #d6e2e6; text-decoration: none; padding: 10px 12px; border-radius: 6px 6px 0 0; font-size: 14px; }
    nav a.active { color: #172026; background: #f5f7f8; }
    .grid { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .metric, .panel { background: white; border: 1px solid #d9e0e3; border-radius: 6px; padding: 14px; }
    .metric b { display: block; font-size: 28px; line-height: 1; }
    .metric span, .muted { color: #60717a; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d9e0e3; margin-bottom: 20px; }
    th, td { text-align: left; border-bottom: 1px solid #e5eaed; padding: 10px 12px; font-size: 14px; vertical-align: top; }
    th { background: #eef3f5; color: #40515a; }
    td span { color: #60717a; font-size: 12px; }
    a { color: #116078; }
    code { background: #eef3f5; padding: 1px 4px; border-radius: 3px; }
    pre { overflow: auto; background: #172026; color: #e8f1f4; padding: 14px; border-radius: 6px; }
    .json-block { max-height: 520px; }
    .config-grid { display: grid; grid-template-columns: repeat(2, minmax(240px, 1fr)); gap: 14px; margin-bottom: 20px; }
    .config-section { background: white; border: 1px solid #d9e0e3; border-radius: 6px; padding: 14px; }
    .config-section.full { grid-column: 1 / -1; }
    .config-section table { margin-bottom: 0; border: 0; }
    .config-section th { width: 38%; }
    .config-form { background: white; border: 1px solid #d9e0e3; border-radius: 6px; padding: 14px; margin-bottom: 20px; }
    .form-grid { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 12px; margin-bottom: 14px; }
    label { display: block; color: #40515a; font-size: 12px; font-weight: 600; }
    input, select, textarea { box-sizing: border-box; width: 100%; min-height: 34px; margin-top: 4px; border: 1px solid #c6d0d5; border-radius: 4px; padding: 6px 8px; background: white; color: #172026; }
    textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    input[type="checkbox"] { width: auto; min-height: auto; margin-right: 6px; }
    fieldset { border: 1px solid #d9e0e3; border-radius: 6px; margin: 0 0 14px; padding: 12px; }
    legend { color: #40515a; font-size: 13px; font-weight: 700; padding: 0 4px; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    button { min-height: 30px; border: 1px solid #0e5c72; border-radius: 4px; padding: 4px 10px; background: #116078; color: white; font-weight: 600; font-size: 13px; cursor: pointer; }
    button.btn-sm { min-height: 28px; padding: 2px 8px; font-size: 12px; }
    button.btn-secondary { background: white; color: #116078; }
    button.btn-danger { background: #c0392b; border-color: #a82716; }
    button[disabled] { background: #d9e0e3; border-color: #c6d0d5; color: #60717a; cursor: not-allowed; }
    button[value="save"], button[value="save-preset"] { background: white; color: #116078; }
    .pill { display: inline-block; padding: 2px 7px; border-radius: 999px; background: #eef3f5; color: #40515a; font-size: 12px; }
    .status { display: inline-block; min-width: 64px; padding: 2px 7px; border-radius: 999px; background: #eef3f5; text-align: center; }
    .ok { background: #d9f2e3; color: #145d32; }
    .bad { background: #ffe0df; color: #8a1f18; }
    /* Unified device list: dense single-line rows that expand on click.
       Built from <details>/<summary> so it works with no JS. */
    .dev-list { background: white; border: 1px solid #d9e0e3; border-radius: 6px; margin-bottom: 20px; }
    .dev-row { border-bottom: 1px solid #e5eaed; }
    .dev-row:last-child { border-bottom: 0; }
    .dev-row > summary { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 8px 12px; cursor: pointer; list-style: none; font-size: 14px; }
    .dev-row > summary::-webkit-details-marker { display: none; }
    .dev-row > summary::before { content: "\\25B8"; color: #8aa0aa; font-size: 11px; width: 10px; flex: 0 0 auto; }
    .dev-row[open] > summary::before { content: "\\25BE"; }
    .dev-row[open] > summary { background: #f5f8f9; }
    .dev-name { font-weight: 600; flex: 1 1 160px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .dev-name a { text-decoration: none; }
    .dev-name .sub { display: block; color: #60717a; font-size: 12px; font-weight: 400; }
    .dev-sum { color: #40515a; font-size: 12px; flex: 0 1 auto; }
    .dev-sum b { color: #172026; font-weight: 600; }
    .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: 0 0 auto; background: #c6d0d5; }
    .dot.on { background: #2e8b57; } .dot.off { background: #c43d34; }
    .dev-act { display: flex; gap: 6px; flex: 0 0 auto; margin-left: auto; align-items: center; }
    .dev-act form { display: inline; margin: 0; }
    .dev-detail { padding: 4px 12px 14px 32px; background: #fbfdfd; }
    .dev-detail dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 0; font-size: 13px; }
    .dev-detail dt { color: #60717a; }
    .dev-detail dd { margin: 0; word-break: break-word; }
    .dev-detail .claim-row { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .dev-tag { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 11px; background: #eef3f5; color: #40515a; }
    .dev-tag.pending { background: #fff3d6; color: #7a5b00; }
    @media (max-width: 850px) {
      .grid, .config-grid, .form-grid { grid-template-columns: 1fr; }
      table { font-size: 12px; }
      /* Long, unbroken tokens (config hashes, hostnames) must wrap, not push
         the table wider than the viewport and force horizontal scroll. */
      td, th { word-break: break-word; overflow-wrap: anywhere; }
      td code, td a { overflow-wrap: anywhere; word-break: break-all; }
      .dev-sum { flex-basis: 100%; }
      .dev-detail dl { grid-template-columns: 1fr; }
      .dev-detail dt { margin-top: 6px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>YEY Boats Display Manager</h1>
    <div class="sub">${escapeHtml(dashboard.serverId)} · ${escapeHtml(dashboard.generatedAt)}</div>
    ${nav(page)}
  </header>
  <main>
    ${body}
  </main>
<div id="relogin-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;align-items:center;justify-content:center;">
  <div style="background:#fff;color:#172026;max-width:360px;padding:20px;border-radius:8px;">
    <h2 style="margin:0 0 8px;">Session expired</h2>
    <p style="margin:0 0 14px;">Your SignalK login has expired, so the action didn't run. Log in again, then retry.</p>
    <a href="/admin/#/login" target="_top" style="display:inline-block;background:#116078;color:#fff;padding:8px 14px;border-radius:4px;text-decoration:none;font-weight:600;">Re-login</a>
    <button type="button" onclick="document.getElementById('relogin-modal').style.display='none'" style="margin-left:8px;background:#fff;color:#116078;">Dismiss</button>
  </div>
</div>
<script>
(function () {
  function looksLikeLogin (resp) {
    return resp.status === 401 || /\\/admin\\/?#?\\/?login|Please Login/i.test(resp.url || '')
  }
  document.addEventListener('submit', async function (e) {
    var form = e.target
    if (!form || String(form.method).toLowerCase() !== 'post') return
    e.preventDefault()
    try {
      var resp = await fetch(form.action, { method: 'POST', body: new FormData(form), redirect: 'follow', credentials: 'include' })
      if (looksLikeLogin(resp)) { document.getElementById('relogin-modal').style.display = 'flex'; return }
      window.location.assign(resp.url || window.location.href)
    } catch (err) {
      document.getElementById('relogin-modal').style.display = 'flex'
    }
  }, true)
})();
</script>
</body>
</html>`
}

function renderPage (manager, dashboard, page, req) {
  // Overview and Devices merged into one home page (2026-06). Both the
  // default/overview case and /ui/devices render the same merged view.
  if (page === 'devices') return renderHomePage(dashboard, dashboard.devices, req, manager)
  if (page === 'device') return renderDevicePage(manager, req.params.id)
  // The standalone config page is merged into the device page's collapsed
  // <details id="config"> section. The legacy 'deviceConfig' key now renders
  // the same unified page (config section open) so old callers stay valid.
  if (page === 'deviceConfig') return renderDevicePage(manager, req.params.id, {}, { openConfig: true })
  // Legacy /ui/discovery URL stays valid; it just renders the same
  // page as /ui/devices now. Old bookmarks keep working.
  if (page === 'discovery') return renderHomePage(dashboard, dashboard.devices, req, manager)
  if (page === 'profiles') return renderProfilesPage(manager.listProfiles().profiles, dashboard.devices)
  if (page === 'preset') return renderPresetPage(manager, req.params.id, dashboard.devices)
  if (page === 'firmware') return renderFirmwarePage(manager.listFirmware(), dashboard.recentFirmwareJobs, manager.firmwareUpgradeMatrix())
  return renderHomePage(dashboard, dashboard.devices, req, manager)
}

// Home page = the overview stat tiles followed by the full devices
// section (pending discovery + registered table + register/scan forms).
// renderDevicesSection is the single source of truth for the devices markup.
function renderHomePage (dashboard, devices, req, manager) {
  const counts = dashboard.counts
  const overview = `
    <section class="grid">
      ${metric(counts.devices, 'Devices')}
      ${metric(counts.online, 'Online')}
      ${metric(counts.configDrift, 'Config drift')}
      ${metric(counts.pendingCommands, 'Pending commands')}
      ${metric(counts.firmwareJobs, 'Firmware jobs')}
    </section>`
  return `${overview}
    ${renderDevicesSection(devices, req, manager)}`
}

function renderDevicesSection (devices, req, manager) {
  // Discovery + registered devices on one page. Previous two-page
  // layout forced operators to bounce between Discovery (to find
  // and claim a device) and Devices (to inspect/configure it).
  // Now the discovery list lives at the top of this same page,
  // grouped under "Pending" - anything not yet registered. Claimed
  // devices drop into the registered table without a navigation
  // switch.
  const host = req && req.headers && req.headers.host ? req.headers.host : ''
  const managerUrl = host ? `http://${host}/plugins/yey-boats-display-manager` : '/plugins/yey-boats-display-manager'
  const discovered = manager ? manager.listDiscoveredDevices().devices : []
  const pendingDevices = discovered.filter((d) => !d.registered)
  const offlineCount = devices.filter((d) => !d.online).length
  const q = (req && req.query) || {}
  const clearedBanner = q.cleared
    ? `<p class="muted" style="color:#2e8b57;">Removed ${escapeHtml(String(q.removed || 0))} ${q.cleared === 'all' ? 'device(s) — list cleared' : 'offline device(s)'}.</p>`
    : ''
  const profiles = manager ? manager.listProfiles().profiles : []
  const act = (path, label, confirmMsg, danger) =>
    `<form method="post" action="/plugins/yey-boats-display-manager/ui/devices/${path}" style="display:inline"
           onsubmit="return confirm('${escapeHtml(confirmMsg)}');">
      <button type="submit" class="btn-sm${danger ? ' btn-danger' : ''}">${escapeHtml(label)}</button>
    </form>`
  return `
    <section class="panel">
      <h2>Devices</h2>
      <p class="muted">${devices.length} registered · ${pendingDevices.length} pending</p>
      ${clearedBanner}
      <div class="actions">
        <button type="button" class="btn-sm" onclick="location.reload()">Refresh</button>
        <button type="button" class="btn-sm btn-secondary"
                onclick="window.open('/yey-boats-display-manager/flash.html','_blank','noopener')">Flash new device (USB)</button>
        ${devices.length ? act('clear-offline', `Clear offline (${offlineCount})`, `Remove all ${offlineCount} offline device(s) from the list?`, false) : ''}
        ${devices.length ? act('clear-all', `Clear all (${devices.length})`, `Remove ALL ${devices.length} registered device(s)? This cannot be undone.`, true) : ''}
      </div>
      ${deviceList(devices, pendingDevices, profiles)}
      <details style="margin-top:20px;"><summary>Register through SignalK / scan network</summary>
        ${renderSignalKRegisterForm(managerUrl)}
        ${renderDiscoveryScanForm()}
      </details>
    </section>`
}

// Unified device list: registered devices and discovered-but-unregistered
// ("pending") devices share one list. Each entry is a dense single-line
// <summary> that expands (pure-CSS <details>) to reveal full detail. This
// keeps the list usable on narrow displays — wide content wraps into the
// expanded panel instead of overflowing a table horizontally.
function deviceList (devices, pendingDevices, profiles) {
  const rows = [
    ...devices.map((device) => registeredDeviceRow(device)),
    ...pendingDevices.map((device) => pendingDeviceRow(device, profiles))
  ].join('')
  if (!rows) {
    return '<p class="muted" style="padding:14px 0;">No devices registered or discovered.</p>'
  }
  return `<div class="dev-list">${rows}</div>`
}

function registeredDeviceRow (device) {
  const url = `/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(device.id)}`
  const dims = `${device.display.width}x${device.display.height}`
  const detail = detailList([
    ['ID', `<code>${escapeHtml(device.id)}</code>`],
    ['Role', escapeHtml(device.role || '')],
    ['Location', escapeHtml(device.location || '')],
    ['Profile', escapeHtml(device.profile)],
    ['Display', escapeHtml(displayLabel(device.display))],
    ['Layout variant', escapeHtml(device.desiredConfig.layoutVariant || '')],
    ['Widget variant', escapeHtml(device.desiredConfig.widgetVariant || '')],
    ['Config drift', device.configDrift ? '<span class="status bad">yes</span>' : '<span class="status ok">no</span>'],
    ['Pending commands', escapeHtml(device.pendingCommands)],
    ['Firmware', escapeHtml(firmwareLabel(device.firmware))],
    ['Last seen', escapeHtml(relativeTime(device.lastSeen))]
  ])
  return `
    <details class="dev-row">
      <summary>
        <span class="dot ${device.online ? 'on' : 'off'}" title="${escapeHtml(device.health)}"></span>
        <span class="dev-name"><a href="${url}">${escapeHtml(device.name || device.id)}</a><span class="sub">${escapeHtml(device.id)}</span></span>
        <span class="dev-sum"><b>${escapeHtml(device.profile)}</b> · ${escapeHtml(dims)}${device.configDrift ? ' · <span class="status bad">drift</span>' : ''}${device.pendingCommands ? ` · ${escapeHtml(device.pendingCommands)} pending` : ''}</span>
        <span class="dev-act">
          <a class="dev-tag" href="${url}#config" onclick="event.stopPropagation()">config</a>
          <form method="post" action="${url}/delete"
                onsubmit="return confirm('Remove this device? Pending commands are dropped.')">
            <button type="submit" class="btn-sm btn-danger">Remove</button>
          </form>
        </span>
      </summary>
      <div class="dev-detail">
        ${detail}
        <p style="margin:8px 0 0;"><a href="${url}">Open device</a> · <a href="${url}#config">Edit config</a></p>
      </div>
    </details>`
}

function pendingDeviceRow (device, profiles) {
  const addr = `${device.address || '?'}${device.port ? ':' + device.port : ''}`
  const detail = detailList([
    ['ID', `<code>${escapeHtml(device.deviceId)}</code>`],
    ['Address', escapeHtml(addr)],
    ['Source', escapeHtml(device.source || '')],
    ['Role', escapeHtml(device.role || '')],
    ['Location', escapeHtml(device.location || '')],
    ['Display', escapeHtml(displayLabel(device.display))],
    ['Firmware', escapeHtml(firmwareLabel(device.firmware))],
    ['Seen count', escapeHtml(device.seenCount != null ? device.seenCount : '')],
    ['Last seen', escapeHtml(relativeTime(device.lastSeen))],
    device.conflict ? ['Conflict', `<span class="status bad">address</span> ${escapeHtml(device.conflict.deviceIds.join(', '))}`] : null
  ])
  return `
    <details class="dev-row">
      <summary>
        <span class="dot" title="discovered, not registered"></span>
        <span class="dev-name">${escapeHtml(device.name || device.deviceId)}<span class="sub">${escapeHtml(device.deviceId)}</span></span>
        <span class="dev-sum">${escapeHtml(addr)}${device.source ? ' · ' + escapeHtml(device.source) : ''} · seen ${escapeHtml(relativeTime(device.lastSeen))}</span>
        <span class="dev-act"><span class="dev-tag pending">pending</span></span>
      </summary>
      <div class="dev-detail">
        ${detail}
        <div class="claim-row">${renderDiscoveryClaimControl(device, profiles)}</div>
      </div>
    </details>`
}

function detailList (pairs) {
  const items = pairs
    .filter(Boolean)
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`)
    .join('')
  return `<dl>${items}</dl>`
}

function renderSignalKRegisterForm (managerUrl) {
  return `
      <form class="config-form" method="post" action="/plugins/yey-boats-display-manager/devices/register-from-signalk">
        <fieldset>
          <legend>Register through SignalK</legend>
          <div class="form-grid">
            ${field('Device address', input('address', '10.42.0.67'))}
            ${field('HTTP port', input('port', '80', 'number', '1', '65535', '1'))}
            ${field('Device ID', input('deviceId', ''))}
            ${field('Preset', input('profileId', 'default'))}
            ${field('Role', input('role', 'display'))}
            ${field('Location', input('location', ''))}
            ${field('Manager URL', input('managerUrl', managerUrl))}
            ${field('Send manager-register', checkbox('sendManagerRegister', true))}
            ${field('Queue reload', checkbox('sendReload', false))}
          </div>
          <div class="actions">
            <button type="submit" name="action" value="register">Register</button>
          </div>
        </fieldset>
      </form>`
}

function renderDevicePage (manager, id, live = {}, opts = {}) {
  const device = manager.getDevice(id)
  const config = manager.generateConfig(id)
  const profilesList = manager.listProfiles().profiles
  // Device's real switchable screens (heartbeat ui.screens) drive the config
  // editors so the screen pickers only offer screens that actually exist.
  let configViews = { views: [], current: null }
  try { configViews = manager.deviceViews(id) || configViews } catch (e) { /* offline */ }
  const commands = manager.store.commands.commands
    .filter((command) => command.deviceId === id)
    .slice(-10)
    .reverse()
  const jobs = manager.store.jobs.jobs
    .filter((job) => job.deviceId === id)
    .slice(-10)
    .reverse()
  const profiles = Object.values(manager.store.profiles.profiles)
  const assigned = device.assignedProfile || 'default'
  const profileOptions = profiles
    .map((p) => `<option value="${escapeHtml(p.id)}"${p.id === assigned ? ' selected' : ''}>` +
      `${escapeHtml(p.name || p.id)}</option>`)
    .join('')
  const views = manager.deviceViews(id)
  const currentScreen = views && views.current
  const screenOptions = (views && Array.isArray(views.views) ? views.views : [])
    .map((v) => `<option value="${escapeHtml(v.id)}"${v.id === currentScreen ? ' selected' : ''}>` +
      `${escapeHtml(v.title || v.id)}</option>`)
    .join('')
  // Live-preview data, driven by the device's REAL screen list (deviceViews)
  // so the preview tracks what the device actually has + which screen is
  // current. Each screen's tiles come from the assigned profile's authored
  // layout when managed, else the screen-presets catalogue that mirrors the
  // firmware's built-in screens — so built-in screens still render live
  // objects. Tiles are flattened to {widgetId,widget,title,path,unit,precision}
  // and bound to live SignalK data by public/live-preview.js.
  const previewData = (() => {
    const prof = manager.store.profiles.profiles[assigned] || {}
    const pcfg = prof.config || {}
    const items = (pcfg.widgets && pcfg.widgets.items) || {}
    const authored = {}
    ;((pcfg.layout && pcfg.layout.screens) || []).forEach((s) => { authored[s.id] = s })
    let presetById = {}
    try {
      const sp = require('./lib/screen-presets')
      const dc = (typeof sp.classifyBoard === 'function')
        ? sp.classifyBoard(String((device.board || (device.display && device.display.class) || '')))
        : 'sunton-480'
      ;(sp.getPresetsForClass(dc) || []).forEach((s) => { presetById[s.id] = s })
    } catch (e) { presetById = {} }
    const PRESET_ALIAS = { status: 'system' } // built-in id -> nearest preset id
    const presetTiles = (screenId) => {
      // exact id, alias, else a prefix match so built-in variants map to their
      // base (wind_classic / wind_steer -> "wind"); gives real SignalK bindings.
      let p = presetById[screenId] || presetById[PRESET_ALIAS[screenId]]
      if (!p) {
        const base = Object.keys(presetById).find((k) => screenId === k || screenId.indexOf(k + '_') === 0)
        if (base) p = presetById[base]
      }
      if (!p || !Array.isArray(p.tiles)) return null
      return p.tiles.map((t) => ({
        widgetId: null, editable: false,
        widget: t.widget || 'numeric', title: t.title || (t.primary ? String(t.primary).split('.').pop() : ''),
        path: t.primary || t.path || '', unit: t.unit || '', precision: t.precision != null ? t.precision : null,
        color: null,
        markers: Array.isArray(t.markers) ? t.markers : null
      }))
    }
    const tilesFor = (screenId) => {
      // A genuinely managed/edited screen (authored tiles WITH real bindings)
      // wins so edits show; an empty-path stub authored layout falls through to
      // the preset catalogue so the preview still shows live objects.
      const a = authored[screenId]
      if (a && Array.isArray(a.tiles) && a.tiles.length) {
        // Authored tiles come in two flavours: a `widget` reference into
        // widgets.items (managed/edited), and inline `primary`/`title` tiles
        // (the seeded layouts). Read both so a mixed screen — e.g. an edited
        // tile next to seeded ones — projects every tile's real binding (and
        // a single rebind doesn't blank the rest of the screen).
        const preset = presetTiles(screenId) || []
        const mapped = a.tiles.map((t, i) => {
          // Managed tile: `t.widget` is a KEY into widgets.items. Seeded tile:
          // `t.widget` is the widget TYPE (compass/numeric/text) and the path
          // lives inline on `t.primary`/`t.path`. Distinguish by whether the
          // key resolves to a widget item.
          const refKey = (t && t.widget && Object.prototype.hasOwnProperty.call(items, t.widget)) ? t.widget : null
          const w = refKey ? items[refKey] : {}
          const p = preset[i] || {}
          const inlineType = (t && t.widget && !refKey) ? t.widget : null
          const inlinePath = (t && (t.primary || t.path)) || ''
          return {
            widgetId: refKey,
            editable: !!refKey,
            widget: w.type || inlineType || p.widget || 'numeric',
            title: w.title || (t && t.title) || p.title || inlineType || '',
            path: w.path || inlinePath || p.path || '',
            unit: w.unit || (t && t.unit) || p.unit || '',
            precision: w.precision != null ? w.precision : (t && t.precision != null ? t.precision : (p.precision != null ? p.precision : null)),
            // Per-element color overrides (element -> #rrggbb). Only the managed
            // widget item carries them; preset/inline tiles default to theme.
            color: (w.color && typeof w.color === 'object') ? w.color : null,
            markers: Array.isArray(w.markers) ? w.markers
              : (Array.isArray(t && t.markers) ? t.markers : (Array.isArray(p.markers) ? p.markers : null))
          }
        })
        if (mapped.some((m) => m.path)) return mapped
      }
      return presetTiles(screenId) || []
    }
    const dvViews = (views && Array.isArray(views.views) ? views.views : [])
    // Device telemetry from the heartbeat status, for the System/status panel
    // (the parts that aren't SignalK: wifi/ip/rssi/ble/sk/heap/psram/uptime/build).
    const st = (device && device.status) || {}
    const telemetry = {
      wifiState: (st.network && st.network.state) || (st.network && st.network.wifi_up ? 'STA' : null),
      ip: st.network && st.network.ip,
      rssi: st.network && st.network.rssi,
      ssid: st.network && st.network.ssid,
      ble: (st.network && st.network.hostname) || device.id,
      signalk: (st.signalk && st.signalk.state) || (st.sk && st.sk.state),
      heapKb: st.memory && st.memory.heap_free_kb,
      psramKb: st.memory && st.memory.psram_free_kb,
      uptimeMs: st.ui && st.ui.uptime_ms,
      build: (st.firmware && (st.firmware.build_time || st.firmware.version)) || null
    }
    // Manifest gating for the rich edit-fields editor (Slice: rich edit mode).
    // The device's reported ui.capabilities (or the built-in default) drives
    // which KINDs the kind-picker offers; COLOR_ELEMENTS tells the editor which
    // color swatches each kind exposes; quantityForPath lets the client filter
    // the path picker to paths COMPATIBLE with the chosen kind. We ship the
    // pure manifest data + the element map so live-preview.js (standalone, no
    // bundler) can gate the UI exactly like lib/field-schema.js does server-side.
    let manifest = fieldSchema.DEFAULT_MANIFEST
    try { manifest = manager.effectiveManifest(id) || fieldSchema.DEFAULT_MANIFEST } catch (e) { manifest = fieldSchema.DEFAULT_MANIFEST }
    const editorManifest = {
      viewTypes: Object.keys((manifest && manifest.viewTypes) || {}),
      units: (manifest && manifest.units) || fieldSchema.DEFAULT_MANIFEST.units,
      colorElements: fieldSchema.COLOR_ELEMENTS
    }
    // Stored HUD field overrides for a fullscreen screen, surfaced back to the
    // preview so the field editor shows current bindings/colours and the live
    // HUD honours them. Read from the authored layout screen's `hud` block.
    const hudFor = (screenId) => {
      const a = authored[screenId]
      if (a && a.hud && a.hud.fields && typeof a.hud.fields === 'object') {
        return { kind: a.hud.kind || null, fields: a.hud.fields }
      }
      return null
    }
    return {
      current: currentScreen,
      profileId: assigned,
      telemetry,
      manifest: editorManifest,
      screens: dvViews.map((v) => {
        const out = { id: v.id, title: v.title || v.id, tiles: tilesFor(v.id) }
        const hud = hudFor(v.id)
        if (hud) out.hud = hud
        return out
      })
    }
  })()
  // SK path catalogue for the edit datalist (the layout-editor's curated list).
  let previewPaths = []
  try { previewPaths = require('./lib/screen-presets').ALL_PATHS || [] } catch (e) { previewPaths = [] }
  // A ?screen= carried through a save redirect pre-selects that screen (and
  // becomes the preview's initial screen) so a full-page reload doesn't snap
  // back to the device's current screen.
  const selectScreen = (opts && opts.selectScreen &&
    previewData.screens.some((s) => s.id === opts.selectScreen)) ? opts.selectScreen : null
  const previewSelected = selectScreen || currentScreen
  const previewScreenOptions = previewData.screens
    .map((s) => `<option value="${escapeHtml(s.id)}"${s.id === previewSelected ? ' selected' : ''}>` +
      `${escapeHtml(s.title)}</option>`)
    .join('')
  if (selectScreen) previewData.initialScreen = selectScreen
  // Curated SK path catalogue for the rich edit-fields path picker (same list
  // that backs the <datalist>), so the picker can offer candidates even before
  // the live stream has delivered a value for every path.
  previewData.previewPaths = previewPaths
  const previewJson = JSON.stringify(previewData).replace(/</g, '\\u003c')
  const otaSection = renderDeviceFirmwareSection(manager, device)
  return `
    <section class="panel">
      <h2>${escapeHtml(device.name || device.id)}</h2>
      <p class="muted">${escapeHtml(device.id)} · ${escapeHtml(device.role)} · ${escapeHtml(device.location || 'unassigned')}</p>
      <p>
        <a href="#config">Configuration</a>
        · <a href="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(id)}/live/status">Live status</a>
        · <a href="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(id)}/live/logs">Live logs</a>
      </p>
      <div class="lp-panel">
        <div class="lp-head">
          <div class="lp-head-title">
            <strong>Live view</strong>
            <span class="lp-now"><span class="lp-dot"></span>on device:&nbsp;<span id="lp-now-screen">…</span></span>
          </div>
        </div>
        <div class="lp-body">
          <div id="lp-root" class="lp-stage"></div>
          <div class="lp-side">
            <div class="lp-controls">
              <label class="lp-ctl lp-ctl-block">Preview screen
                <select id="lp-screen">${previewScreenOptions || '<option value="">(none)</option>'}</select></label>
              <label class="lp-ctl lp-edit-toggle"><input type="checkbox" id="lp-edit">&nbsp;Edit fields</label>
            </div>
            <form id="lp-form" method="post"
                  action="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(id)}/save-screen">
              <input type="hidden" name="screenId" id="lp-f-screen">
              <input type="hidden" name="edits" id="lp-f-edits">
              <input type="hidden" name="mode" id="lp-f-mode" value="update">
              <div class="lp-actions">
                <button type="button" class="primary btn-sm" data-mode="switch" title="Show the selected screen on the device now">Show on device</button>
                <button type="button" class="btn-sm" data-mode="update" title="Save edits to the assigned view + reload the device">Save to view</button>
                <span class="lp-create">
                  <input type="text" name="profileName" id="lp-f-name" placeholder="new view name">
                  <button type="button" class="btn-sm" data-mode="create" title="Save the edited layout as a new view">Save as new</button>
                </span>
              </div>
            </form>
            <p class="muted lp-note" id="lp-note"><strong>Show on device</strong> switches the
              device to the selected screen now; tick <strong>Edit fields</strong> to rebind a
              tile's SignalK path, then <strong>Save to view</strong> or <strong>Save as new</strong>.</p>
          </div>
        </div>
        <datalist id="lp-paths">${previewPaths.map((p) => `<option value="${escapeHtml(p)}"></option>`).join('')}</datalist>
      </div>
      <form class="config-form lp-assign" method="post"
            action="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(id)}/switch-view">
        <div class="lp-assign-row">
          <label for="switch-view-profile">Assigned profile</label>
          <select id="switch-view-profile" name="profileId">${profileOptions}</select>
          <button type="submit" class="btn-sm">Assign + reload</button>
        </div>
      </form>
      <style>
        .lp-panel{background:linear-gradient(180deg,#0e1a26,#0b1019);border:1px solid #1e3142;border-radius:12px;padding:16px;margin-bottom:18px;box-shadow:0 1px 0 #1a2c3c inset,0 6px 22px rgba(0,0,0,.28)}
        /* Lazy-loaded live sections: keep the placeholder's header/Refresh,
           flatten the injected widget's own <section>/<h2> chrome so it doesn't
           double up the title or nest a card inside a card. */
        .live-section .live-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
        .live-section .live-head h2{margin:0}
        .live-section .live-slot section.config-section{background:none;border:0;border-radius:0;padding:0;margin:0}
        .live-section .live-slot section.config-section>h2{display:none}
        .lp-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;color:#cfe0f0;flex-wrap:wrap}
        .lp-head-title{display:flex;align-items:baseline;gap:12px}
        .lp-head-title strong{font-size:15px;letter-spacing:.02em}
        .lp-now{display:inline-flex;align-items:center;font-size:12px;color:#8fb8da;background:#0a1420;border:1px solid #1c3043;border-radius:999px;padding:3px 10px}
        .lp-now #lp-now-screen{color:#eaf2fb;font-weight:600}
        .lp-dot{width:8px;height:8px;border-radius:50%;background:#36d399;margin-right:7px;box-shadow:0 0 0 0 rgba(54,211,153,.6);animation:lp-pulse 2s infinite}
        @keyframes lp-pulse{0%{box-shadow:0 0 0 0 rgba(54,211,153,.55)}70%{box-shadow:0 0 0 6px rgba(54,211,153,0)}100%{box-shadow:0 0 0 0 rgba(54,211,153,0)}}
        .lp-head-controls{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
        .lp-ctl{font-size:12px;color:#8fb8da;display:inline-flex;align-items:center}
        .lp-ctl select{margin-left:4px;background:#0a1420;color:#eaf2fb;border:1px solid #2a4156;border-radius:6px;padding:4px 6px}
        /* Side-by-side: square stage on the left, all controls grouped on the
           right so the whole live view fits one screen without scrolling. */
        .lp-body{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
        .lp-side{flex:1;min-width:230px;display:flex;flex-direction:column;gap:12px}
        .lp-controls{display:flex;flex-direction:column;gap:10px;background:#0a1420;border:1px solid #1c3043;border-radius:9px;padding:12px}
        .lp-ctl-block{flex-direction:column;align-items:stretch;gap:5px;color:#9fc0dd;font-size:11px;letter-spacing:.04em;text-transform:uppercase}
        .lp-ctl-block select{margin-left:0;font-size:14px;padding:7px 8px;text-transform:none}
        /* Square stage that never overflows: cap at 360px but shrink with the
           container (no vw — unreliable inside the SignalK admin iframe), and
           drop the min-width so a 390px phone can't be forced wider. */
        .lp-stage{box-sizing:border-box;background:radial-gradient(120% 120% at 50% 0%,#0c151f,#070b11);border:1px solid #16242f;border-radius:10px;aspect-ratio:1/1;width:min(360px,100%);max-width:100%;min-width:0;margin:0;padding:10px;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
        .lp-hud{width:100%;height:100%;display:flex;align-items:center;justify-content:center}
        .lp-hud .hud-svg{width:100%;height:100%;display:block}
        /* HUD field editor: when editing a fullscreen HUD the stage drops its
           square aspect, the dial caps to a square at the top, and the field
           panel stacks below it — scrollable, fits a 390px phone column. */
        .lp-stage.lp-editing .lp-hud{height:auto;aspect-ratio:1/1;max-height:340px;flex:0 0 auto}
        .lp-stage.lp-editing .lp-hud .hud-svg{height:auto;aspect-ratio:1/1}
        .lp-hud-edit{margin-top:10px}
        .lp-hud-note{font-size:11px;line-height:1.4;color:#d4b483;background:#1c1606;border:1px solid #3a2f12;border-radius:6px;padding:6px 8px;text-transform:none;letter-spacing:0;margin-bottom:4px}
        .lp-compass{width:100%;height:100%;display:flex;align-items:center;justify-content:center}
        /* SVG dial: square via aspect-ratio, sized by the smaller dimension so
           it stays a circle in any tile shape (height:auto, never stretched). */
        .lp-compass .hud-tile-svg{width:100%;height:auto;max-width:100%;max-height:100%;aspect-ratio:1/1}
        /* CSS-circle ring: force a square box (aspect-ratio) and cap by the
           tile width so it renders as a perfect circle on a phone, never an
           ellipse. */
        .lp-ring{position:relative;width:130px;max-width:100%;aspect-ratio:1/1;height:auto;border-radius:50%;border:2px solid #4fc3f7;display:flex;align-items:center;justify-content:center;margin:0 auto}
        .lp-ring.lp-rose{border-color:#ffb84d}
        .lp-ring .lp-card{position:absolute;color:#8fa7bd;font-size:12px;font-weight:700}
        .lp-card-n{top:6px;left:50%;transform:translateX(-50%);color:#eef4fa}
        .lp-card-e{right:8px;top:50%;transform:translateY(-50%)}
        .lp-card-s{bottom:6px;left:50%;transform:translateX(-50%)}
        .lp-card-w{left:8px;top:50%;transform:translateY(-50%)}
        .lp-ring .lp-rmark{position:absolute;font-size:13px;line-height:1;font-weight:700}
        /* DMS position: two lines that shrink-to-fit the tile. clamp() scales
           the font with the tile width (cqw via the tile container query, with
           a vw fallback) so "36°23.868'N" / "16°4.434'E" never spill out or
           clip at 390px or desktop. No ellipsis — both full lines must show. */
        .lp-val.lp-val-pos{font-size:clamp(11px,9cqw,17px);line-height:1.15;white-space:pre-line;font-weight:600;width:100%;max-width:100%;overflow-wrap:anywhere;word-break:break-word}
        .lp-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-auto-rows:1fr;gap:10px;width:100%;height:100%}
        /* Edit mode: the rich per-tile editor makes tiles tall, so the stage
           drops its square aspect and lets the grid grow + scroll. Tiles keep
           their own min-height but stop clipping the editor (overflow visible). */
        .lp-stage.lp-editing{aspect-ratio:auto;height:auto;max-width:100%;width:min(420px,100%);align-items:stretch;overflow:visible;flex-direction:column}
        .lp-grid-edit{grid-auto-rows:auto;height:auto}
        .lp-grid-edit .lp-tile{overflow:visible;min-height:0}
        /* min-width:0 lets the grid tracks actually share the width equally —
           without it a tile's big value text sets an auto min-width that pushes
           the column (and the whole grid) past the square stage. */
        .lp-tile{min-width:0;overflow:hidden;background:#11202f;border:1px solid #1c2f42;border-radius:9px;padding:10px;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;min-height:80px;container-type:inline-size}
        .lp-cap{font-size:11px;letter-spacing:.1em;color:#6f97ba;text-transform:uppercase}
        .lp-val{font-size:34px;font-weight:650;color:#eaf2fb;line-height:1.05;align-self:flex-start;max-width:100%;overflow:hidden;text-overflow:ellipsis}
        .lp-val-sm{font-size:18px}
        .lp-unit{font-size:14px;color:#9bb6d0;margin-left:5px;font-weight:400}
        .lp-bar{width:20px;flex:1;background:#0a1420;border-radius:5px;display:flex;align-items:flex-end;margin:8px 0;min-height:40px;align-self:center}
        .lp-bar-fill{width:100%;background:linear-gradient(180deg,#52e0a8,#2bb47e);border-radius:5px;transition:height .25s ease}
        .lp-empty{color:#6f97ba;font-size:13px;text-align:center;line-height:1.5}
        .lp-edit-path{width:100%;margin-top:0;font-size:11px;background:#0a1420;color:#cfe0f0;border:1px solid #2a4156;border-radius:5px;padding:4px 5px;box-sizing:border-box}
        .lp-edit-path:focus{outline:none;border-color:#36d399}
        /* Rich edit-fields panel: a stacked, scrollable control group per tile.
           Stacks vertically so it fits a 390px phone column without overflow. */
        .lp-edit{width:100%;margin-top:8px;display:flex;flex-direction:column;gap:7px;border-top:1px solid #1c2f42;padding-top:8px;box-sizing:border-box}
        .lp-edit-row{display:flex;align-items:center;gap:6px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:#7fa6c6}
        .lp-edit-col{flex-direction:column;align-items:stretch;gap:4px}
        .lp-edit-lab{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:#7fa6c6}
        .lp-edit-sel{flex:1;min-width:0;background:#0a1420;color:#eaf2fb;border:1px solid #2a4156;border-radius:5px;padding:4px 5px;font-size:12px;text-transform:none}
        .lp-edit-cur{font-size:11px;color:#9bb6d0;text-transform:none;letter-spacing:0;overflow-wrap:anywhere;word-break:break-word}
        /* Scrollable candidate path list with live values. Capped height so the
           tile stays compact; each row is a full-width clickable button. */
        .lp-edit-paths{max-height:118px;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:2px;border:1px solid #1c2f42;border-radius:6px;background:#091320;padding:3px}
        .lp-edit-prow{display:flex;justify-content:space-between;gap:8px;align-items:center;width:100%;max-width:100%;text-align:left;background:transparent;border:0;border-radius:4px;padding:3px 6px;cursor:pointer;color:#cfe0f0;font-size:11px;text-transform:none;letter-spacing:0;box-sizing:border-box}
        .lp-edit-prow:hover{background:#13283a}
        .lp-edit-prow.active{background:#173a2c;color:#8ff0c0}
        .lp-edit-pname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}
        /* Live-value readout: cap its share + ellipsis so a long string value
           (e.g. a /resources/routes/... id) can't blow the row width past the
           tile on a phone. */
        .lp-edit-plv{color:#9bb6d0;flex:0 1 auto;min-width:0;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
        .lp-edit-color{flex-wrap:wrap}
        .lp-edit-clab{flex:0 0 46px;font-size:10px;color:#7fa6c6}
        .lp-edit-sw{display:flex;align-items:center;gap:4px;flex-wrap:wrap;flex:1;min-width:0}
        .lp-sw{width:16px;height:16px;border-radius:4px;cursor:pointer;border:1px solid rgba(255,255,255,.18);box-sizing:border-box}
        .lp-sw.active{outline:2px solid #eef4fa;outline-offset:1px}
        .lp-sw-custom{width:22px;height:18px;padding:0;border:1px solid #2a4156;border-radius:4px;background:#0a1420;cursor:pointer}
        .lp-sw-theme{font-size:10px;text-transform:none;letter-spacing:0;background:#13283a;color:#9bb6d0;border:1px solid #2a4156;border-radius:5px;padding:2px 7px;cursor:pointer}
        .lp-sw-theme.active{border-color:#36d399;color:#8ff0c0}
        /* Compact control group: tight, wrapping row of small buttons. */
        .lp-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
        .lp-actions button{border-radius:6px;padding:4px 9px;border:1px solid #2a4156;background:#13283a;color:#dbe9f6;cursor:pointer;font-size:12px;min-height:28px;line-height:1}
        .lp-actions button:hover{border-color:#3a607e;background:#173248}
        .lp-actions button.primary{background:#1f8f5f;border-color:#27a86e;color:#eafff5;font-weight:600}
        .lp-actions button.primary:hover{background:#27a86e}
        .lp-create{display:inline-flex;gap:5px;align-items:center}
        .lp-create input{flex:0 1 130px;background:#0a1420;color:#eaf2fb;border:1px solid #2a4156;border-radius:6px;padding:5px 7px;font-size:12px;min-width:0;min-height:28px}
        .lp-note{font-size:12px;line-height:1.5;margin:2px 0 0}
        .lp-assign{margin-bottom:18px}
        /* Compact one-line assign control. */
        .lp-assign .lp-assign-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .lp-assign label{font-size:12px;color:#8fb8da;margin:0;white-space:nowrap}
        .lp-assign select{width:auto;min-width:160px;margin:0}
        .lp-assign button{margin:0}
      </style>
      <script>window.__yeyboatsPreview=${previewJson};window.__yeyboatsDeviceId=${JSON.stringify(id)};</script>
      <script src="/yey-boats-display-manager/device-hud.js"></script>
      <script src="/yey-boats-display-manager/live-preview.js"></script>
      <div class="config-grid">
        ${renderLiveSectionPlaceholder('status', 'Live status', 'Loading status…')}
        ${renderLiveSectionPlaceholder('logs', 'Live logs', 'Loading logs…')}
      </div>
      ${renderLiveLazyLoadScript(id)}
      <table>
        <tbody>
          <tr><th>Profile</th><td>${escapeHtml(device.assignedProfile || 'default')}</td></tr>
          <tr><th>Last seen</th><td>${escapeHtml(device.lastSeen || 'never')}</td></tr>
          <tr><th>Display</th><td>${escapeHtml(displayLabel(manager.resolveDisplay(device)))}</td></tr>
          <tr><th>Firmware</th><td>${escapeHtml(firmwareLabel(device.firmware))}</td></tr>
          <tr><th>Desired hostname</th><td>${escapeHtml(device.networkIdentity && device.networkIdentity.desiredFqdn)}</td></tr>
          <tr><th>Config hash</th><td><code>${escapeHtml(config.hash)}</code></td></tr>
        </tbody>
      </table>
      <h2>Recent commands</h2>
      ${commandTable(commands)}
      ${otaSection}
      <h2>Firmware jobs</h2>
      ${firmwareJobTable(jobs)}
      ${renderDeviceConfigDetails(device, config, profilesList, configViews, opts.openConfig)}
    </section>`
}

// The former standalone config page, now a COLLAPSED section embedded on the
// device detail page. <details id="config"> is closed by default; it opens
// when the page is navigated to with #config (anchor) — old /config links and
// the device-list "config" tag both point at #config — or when rendered with
// opts.openConfig (the legacy deviceConfig route). renderDeviceConfigForm (flat
// settings + the consolidated widget/path editor + screen/tile editor, all in
// one form) and the read-only renderDeviceConfigWidget preview live here so the
// PATHS and FIELDS are editable on the same screen as everything else.
function renderDeviceConfigDetails (device, config, profiles, views, open) {
  const id = device.id
  return `
      <details class="dev-config" id="config"${open ? ' open' : ''}>
        <summary><span class="dev-config-title">Configuration</span><span class="muted dev-config-hint"> — paths, fields, screens &amp; device settings</span></summary>
        <div class="dev-config-body">
          <p class="muted">
            Operator config for ${escapeHtml(id)}. The device pull endpoint still
            requires <code>X-YeyBoats-Authorization</code>.
          </p>
          ${renderDeviceConfigForm(device, config, profiles, views)}
          ${renderDeviceConfigWidget(config, views)}
        </div>
      </details>
      <style>
        .dev-config{background:white;border:1px solid #d9e0e3;border-radius:6px;margin-top:8px}
        .dev-config>summary{cursor:pointer;padding:12px 14px;font-size:16px;list-style:none;display:flex;align-items:baseline;gap:6px}
        .dev-config>summary::-webkit-details-marker{display:none}
        .dev-config>summary::before{content:"\\25B8";color:#8aa0aa;font-size:12px}
        .dev-config[open]>summary::before{content:"\\25BE"}
        .dev-config[open]>summary{border-bottom:1px solid #e5eaed}
        .dev-config-title{font-weight:700;color:#172026}
        .dev-config-body{padding:14px}
        .dev-config-body .config-form{margin-bottom:14px}
      </style>
      <script>
        // Open the config section when the page is anchored at #config so old
        // /config bookmarks (now redirected to .../#config) land with it open.
        (function () {
          function openIfHash () {
            if (location.hash === '#config') {
              var d = document.getElementById('config')
              if (d) { d.open = true; d.scrollIntoView() }
            }
          }
          openIfHash()
          window.addEventListener('hashchange', openIfHash)
        })()
      </script>`
}

// Per-device "Update Firmware" control. Reuses the EXISTING OTA mechanism: the
// OTA form POSTs to .../firmware/update which calls manager.createFirmwareJob;
// the device pulls + self-flashes the artifact. A connection pre-flight
// (manager.validateOtaTarget — same online predicate as the device table)
// renders a checklist and disables the OTA submit when an OTA can't succeed.
// The serial/USB path is embedded inline (esp-web-tools vendored same-origin),
// no longer a link out to flash.html. It pre-selects the firmware artifact that
// matches THIS device's board + resolution using GET /firmware/targets +
// /firmware/catalog, then drives the vendored <esp-web-install-button> against
// /firmware/manifest/:id (which streams the same-origin /binary). Flashing stays
// browser-local Web Serial.
function renderDeviceFirmwareSection (manager, device) {
  const id = device.id
  const v = manager.validateOtaTarget(id)
  // This device's board + display, used to pre-select the matching artifact in
  // the inline USB flasher. resolution string matches firmwareTargets() format.
  const disp = (typeof manager.resolveDisplay === 'function' ? manager.resolveDisplay(device) : device.display) || {}
  const deviceBoard = device.board || (device.firmware && device.firmware.board) || ''
  const deviceResolution = (disp.width && disp.height) ? `${disp.width}×${disp.height}` : ''
  const artifacts = (manager.store.firmware.artifacts || [])
    .slice()
    .sort((a, b) => String((b.firmware && b.firmware.version) || b.version || '')
      .localeCompare(String((a.firmware && a.firmware.version) || a.version || ''),
        undefined, { numeric: true, sensitivity: 'base' }))
  const artifactOptions = artifacts.map((artifact) => {
    const version = (artifact.firmware && artifact.firmware.version) || artifact.version || artifact.artifactId
    return `<option value="${escapeHtml(artifact.artifactId)}">${escapeHtml(`${version} · ${artifact.artifactId}`)}</option>`
  }).join('')
  const check = (label, ok, hint) =>
    `<li><span class="status ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</span> ${escapeHtml(label)}${hint ? ` <span class="muted">${escapeHtml(hint)}</span>` : ''}</li>`
  const ready = v.ready
  // Unique ids so the inline toggle script is scoped to this section.
  const formId = 'fw-ota-form'
  const serialId = 'fw-serial'
  const methodSel = 'fw-method'
  return `
      <h2>Update Firmware</h2>
      <div class="config-section">
        ${v.exists ? '' : '<p class="muted">Device is not registered.</p>'}
        <ul class="fw-checklist" style="list-style:none;padding:0;margin:0 0 12px;display:flex;flex-direction:column;gap:6px;">
          ${check('Online', v.online, v.online ? '' : 'no recent heartbeat')}
          ${check('Address known', v.addressKnown, v.addressKnown ? '' : 'no IP / hostname resolved')}
          ${check('Artifact in catalogue', v.hasArtifact, v.hasArtifact ? '' : 'upload firmware first')}
        </ul>
        <label class="fw-ctl" style="display:block;margin-bottom:10px;">Method
          <select id="${methodSel}" style="margin-left:6px;">
            <option value="ota" selected>OTA (over WiFi)</option>
            <option value="serial">Serial (USB)</option>
          </select>
        </label>
        <div id="${formId}">
          <form method="post" action="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(id)}/firmware/update">
            <label class="fw-ctl">Artifact
              <select name="artifactId" style="margin-left:6px;">
                ${artifactOptions || '<option value="">(no artifacts in catalogue)</option>'}
              </select>
            </label>
            <input type="hidden" name="reboot" value="true">
            <input type="hidden" name="confirmAfterBoot" value="true">
            <div class="actions" style="margin-top:10px;">
              <button type="submit"${ready ? '' : ' disabled'}>Queue OTA update</button>
            </div>
          </form>
          ${ready ? '' : '<p class="muted">Device offline or no artifact — resolve the checklist above before OTA.</p>'}
        </div>
        <div id="${serialId}" style="display:none;">
          <p class="muted" style="margin-top:0;">
            Plug this device into your computer over USB; flashing runs entirely
            in your browser over Web Serial (nothing flows through the SignalK host).
          </p>
          <div id="fw-usb-insecure" class="muted" style="display:none;color:#8a5a18;">
            USB flashing needs a secure context — open this page via
            <code>http://localhost</code> (SSH tunnel) or HTTPS on the computer
            the device is plugged into. Or use
            <a href="/yey-boats-display-manager/flash.html" target="_blank" rel="noopener">the full Flash tool</a>.
          </div>
          <label class="fw-ctl" style="display:block;margin-bottom:8px;">USB firmware build
            <select id="fw-usb-artifact" style="margin-left:6px;min-width:260px;">
              <option value="">Loading catalog…</option>
            </select>
          </label>
          <p id="fw-usb-status" class="muted" style="margin:4px 0 10px;"></p>
          <div class="actions">
            <esp-web-install-button id="fw-usb-btn">
              <button slot="activate" type="button">Connect &amp; flash via USB</button>
              <span slot="unsupported">Web Serial unsupported — use Chrome/Edge over HTTPS or localhost.</span>
              <span slot="not-allowed">Serial access was not granted.</span>
            </esp-web-install-button>
          </div>
          <p class="muted" style="margin-top:8px;">
            Need provisioning or device-detection too?
            <a href="/yey-boats-display-manager/flash.html" target="_blank" rel="noopener">Open the full Flash tool →</a>
          </p>
        </div>
      </div>
      <script type="module" src="/yey-boats-display-manager/vendor/install-button.js"></script>
      <script>
        (function () {
          var BASE = '/plugins/yey-boats-display-manager'
          var sel = document.getElementById('${methodSel}')
          var ota = document.getElementById('${formId}')
          var serial = document.getElementById('${serialId}')
          if (!sel || !ota || !serial) return
          function sync () {
            var serialMode = sel.value === 'serial'
            ota.style.display = serialMode ? 'none' : ''
            serial.style.display = serialMode ? '' : 'none'
            if (serialMode) initUsb()
          }
          sel.addEventListener('change', sync)

          // ---- inline USB flasher (esp-web-tools, vendored same-origin) ----
          var DEVICE_BOARD = ${JSON.stringify(deviceBoard)}
          var DEVICE_RES = ${JSON.stringify(deviceResolution)}
          var usbSel = document.getElementById('fw-usb-artifact')
          var usbBtn = document.getElementById('fw-usb-btn')
          var usbStatus = document.getElementById('fw-usb-status')
          var usbInsecure = document.getElementById('fw-usb-insecure')
          var usbInited = false
          var targets = []
          var artifacts = []

          function artifactKind (a) { return (a && a.source && a.source.kind) || 'release' }
          function artifactTarget (a) { return (a && a.compatibility && a.compatibility.releaseTarget) || null }
          function metaFor (t) { return targets.find(function (x) { return x.target === t }) }
          function artifactLabel (a) {
            var ver = (a.firmware && a.firmware.version) || a.version || '?'
            var t = artifactTarget(a)
            var meta = metaFor(t)
            var resTxt = meta && meta.resolution ? ' · ' + meta.resolution : ''
            var tgtTxt = t ? ' · ' + t : ''
            var prefix = 'v' + ver
            if (artifactKind(a) === 'tip') prefix = 'TIP (v' + ver + ')'
            else if (artifactKind(a) === 'prerelease') prefix = 'v' + ver + ' (prerelease)'
            return prefix + tgtTxt + resTxt
          }
          // Does artifact a match THIS device's board / resolution?
          function matchesDevice (a) {
            var t = artifactTarget(a)
            var meta = metaFor(t)
            if (!meta) return false
            if (DEVICE_BOARD && meta.board && meta.board === DEVICE_BOARD) return true
            if (DEVICE_RES && meta.resolution && meta.resolution === DEVICE_RES) return true
            return false
          }
          function applyManifest () {
            if (!usbBtn) return
            var id = usbSel.value
            if (!id) { usbBtn.removeAttribute('manifest'); return }
            usbBtn.manifest = BASE + '/firmware/manifest/' + encodeURIComponent(id)
          }
          function renderArtifacts () {
            // RELEASES-style view: release + tip builds. Matching device builds
            // float to the top so the right one is pre-selected.
            var visible = artifacts.filter(function (a) {
              var k = artifactKind(a)
              return k === 'release' || k === 'tip'
            })
            visible.sort(function (a, b) {
              var am = matchesDevice(a) ? 0 : 1
              var bm = matchesDevice(b) ? 0 : 1
              if (am !== bm) return am - bm
              var at = artifactKind(a) === 'tip' ? 0 : 1
              var bt = artifactKind(b) === 'tip' ? 0 : 1
              return at - bt
            })
            usbSel.innerHTML = ''
            if (!visible.length) {
              usbSel.innerHTML = '<option value="">No firmware builds in catalog</option>'
              usbStatus.textContent = 'Catalog is empty — upload or refresh firmware first.'
              applyManifest()
              return
            }
            var firstMatch = null
            visible.forEach(function (a) {
              var opt = document.createElement('option')
              opt.value = a.artifactId
              opt.textContent = artifactLabel(a) + (matchesDevice(a) ? '  ✓ this device' : '')
              usbSel.appendChild(opt)
              if (firstMatch == null && matchesDevice(a)) firstMatch = a.artifactId
            })
            if (firstMatch) usbSel.value = firstMatch
            applyManifest()
            usbStatus.textContent = firstMatch
              ? 'Pre-selected the build matching this device (' + (DEVICE_BOARD || DEVICE_RES) + ').'
              : 'No exact match for this device — pick a build manually.'
          }
          function gate () {
            var ok = ('serial' in navigator) && window.isSecureContext
            if (!ok) {
              if (usbInsecure) usbInsecure.style.display = ''
              if (usbBtn) usbBtn.style.display = 'none'
            }
            return ok
          }
          function initUsb () {
            if (usbInited) return
            usbInited = true
            gate()
            usbSel.addEventListener('change', applyManifest)
            Promise.all([
              fetch(BASE + '/firmware/targets', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : { targets: [] } }).catch(function () { return { targets: [] } }),
              fetch(BASE + '/firmware/catalog', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : { artifacts: [] } }).catch(function () { return { artifacts: [] } })
            ]).then(function (res) {
              targets = (res[0] && res[0].targets) || []
              artifacts = (res[1] && res[1].artifacts) || []
              renderArtifacts()
            })
          }
          sync()
        })()
      </script>`
}

// Lightweight placeholder rendered in place of the live widget. The client
// fetches the matching *-fragment endpoint after load and replaces the inner
// content (.live-slot) with the real widget HTML. data-kind picks the endpoint.
function renderLiveSectionPlaceholder (kind, title, loadingText) {
  return `
    <section class="config-section live-section" data-live-kind="${escapeHtml(kind)}">
      <div class="live-head">
        <h2>${escapeHtml(title)}</h2>
        <button type="button" class="btn-sm live-refresh" data-live-kind="${escapeHtml(kind)}">Refresh</button>
      </div>
      <div class="live-slot" data-live-kind="${escapeHtml(kind)}">
        <p class="lp-note" style="color:#6f97ba;">${escapeHtml(loadingText)}</p>
      </div>
    </section>`
}

// Inline (SSR, no build step) client script: lazy-loads each live section's
// fragment after the page is interactive, with an AbortController timeout so a
// dead device can't hang the widget. On 401 / SignalK login redirect it sends
// the *top* frame (the manager UI runs inside the SignalK admin iframe) to the
// login page rather than showing a dismissable modal.
function renderLiveLazyLoadScript (id) {
  const base = `/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(id)}/live`
  return `
    <script>
    (function () {
      var BASE = ${JSON.stringify(base)};
      var ENDPOINT = { status: BASE + '/status-fragment', logs: BASE + '/logs-fragment' };
      function looksLikeLogin (resp) {
        return resp.status === 401 || /\\/admin\\/?#?\\/?login|Please Login/i.test(resp.url || '')
      }
      function toLogin () { try { window.top.location.assign('/admin/#/login') } catch (e) { window.location.assign('/admin/#/login') } }
      function errorWidget (title, msg) {
        return '<p class="lp-note" style="color:#d96f6f;"><strong>' + title + ' unavailable.</strong> ' + msg + '</p>'
      }
      async function load (kind) {
        var slot = document.querySelector('.live-slot[data-live-kind="' + kind + '"]')
        if (!slot) return
        var url = ENDPOINT[kind]
        if (!url) return
        slot.innerHTML = '<p class="lp-note" style="color:#6f97ba;">Loading…</p>'
        var ctrl = new AbortController()
        var timer = setTimeout(function () { ctrl.abort() }, 8000)
        try {
          var resp = await fetch(url, { credentials: 'include', redirect: 'follow', signal: ctrl.signal })
          clearTimeout(timer)
          if (looksLikeLogin(resp)) { toLogin(); return }
          var html = await resp.text()
          if (/\\/admin\\/?#?\\/?login|Please Login/i.test(html)) { toLogin(); return }
          slot.innerHTML = html
        } catch (err) {
          clearTimeout(timer)
          var why = (err && err.name === 'AbortError') ? 'Device did not respond (timed out).' : 'Could not reach the device.'
          slot.innerHTML = errorWidget(kind === 'status' ? 'Live status' : 'Live logs', why)
        }
      }
      function init () {
        var btns = document.querySelectorAll('.live-refresh')
        for (var i = 0; i < btns.length; i++) {
          (function (b) { b.addEventListener('click', function () { load(b.getAttribute('data-live-kind')) }) })(btns[i])
        }
        load('status')
        load('logs')
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
      else init()
    })();
    </script>`
}

function renderLiveStatusWidget (status, err) {
  if (err) return liveErrorWidget('Live status', err)
  if (!status) return liveErrorWidget('Live status', { message: 'no live status fetched' })
  return `
    <section class="config-section">
      <h2>Live status</h2>
      ${keyValueTable([
        ['Device', status.device && status.device.id],
        ['WiFi', status.wifi ? `${status.wifi.state || ''} ${status.wifi.ip || ''}`.trim() : ''],
        ['SignalK', status.sk && status.sk.state],
        ['Manager', status.manager && status.manager.health],
        ['Screen', status.screen && status.screen.id],
        ['Touch', status.touch && status.touch.mode]
      ])}
    </section>`
}

function renderLiveLogsWidget (logs, err) {
  if (err) return liveErrorWidget('Live logs', err)
  if (!logs) return liveErrorWidget('Live logs', { message: 'no live logs fetched' })
  const entries = Array.isArray(logs.entries)
    ? logs.entries
    : Array.isArray(logs.logs)
      ? logs.logs
      : []
  const recent = entries.slice(-5).map((entry) => [
    entry.seq != null ? entry.seq : '',
    entry.line || entry.message || JSON.stringify(entry)
  ])
  return `
    <section class="config-section">
      <h2>Live logs</h2>
      ${simpleTable(['Seq', 'Message'], recent, 'No live log entries returned.')}
    </section>`
}

function liveErrorWidget (title, err) {
  const message = err && err.payload && err.payload.error
    ? err.payload.error.message
    : err && err.message
      ? err.message
      : 'live device request failed'
  const code = err && err.payload && err.payload.error
    ? err.payload.error.code
    : 'live_request_failed'
  return `
    <section class="config-section">
      <h2>${escapeHtml(title)}</h2>
      ${keyValueTable([
        ['Status', { __html: '<span class="status bad">unreachable</span>' }],
        ['Error', code],
        ['Message', message]
      ])}
    </section>`
}

function renderLiveStatusPage (manager, id, status) {
  const device = manager.getDevice(id)
  const rows = [
    ['Device ID', status.device && status.device.id],
    ['Uptime', status.device && status.device.uptime_ms != null ? `${status.device.uptime_ms} ms` : ''],
    ['WiFi', status.wifi ? `${status.wifi.state || ''} ${status.wifi.ip || ''}`.trim() : ''],
    ['RSSI', status.wifi && status.wifi.rssi],
    ['SignalK', status.sk && status.sk.state],
    ['Manager', status.manager && status.manager.health],
    ['Screen', status.screen && `${status.screen.id || ''} (${status.screen.index != null ? status.screen.index : '?'}/${status.screen.count != null ? status.screen.count : '?'})`],
    ['Theme', status.ui && status.ui.theme],
    ['Brightness', status.display && status.display.brightness],
    ['Touch', status.touch && `${status.touch.mode || ''} ${status.touch.pressed ? 'pressed' : ''}`.trim()]
  ]
  return renderUiShell('Live status', `
    <section class="panel">
      <h2>${escapeHtml(device.name || device.id)} live status</h2>
      <p>
        <a href="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(id)}">Back to device</a>
        · <a href="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(id)}/live/status">Refresh</a>
        · <a href="/plugins/yey-boats-display-manager/devices/${encodeURIComponent(id)}/live/status">Raw JSON</a>
      </p>
      ${keyValueTable(rows)}
      ${status.manager && Array.isArray(status.manager.recentErrors) && status.manager.recentErrors.length
        ? `<h2>Recent device errors</h2>${simpleTable(['Time', 'Message'], status.manager.recentErrors.map((entry) => [entry.t_ms, entry.msg]))}`
        : ''}
      <h2>Full status</h2>
      <pre class="json-block">${escapeHtml(JSON.stringify(status, null, 2))}</pre>
    </section>`)
}

function renderLiveLogsPage (manager, id, logs) {
  const device = manager.getDevice(id)
  const entries = Array.isArray(logs.entries)
    ? logs.entries
    : Array.isArray(logs.logs)
      ? logs.logs
      : []
  const rows = entries.map((entry) => [
    entry.seq != null ? entry.seq : '',
    entry.t_ms != null ? entry.t_ms : (entry.time || ''),
    entry.level || '',
    entry.line || entry.message || JSON.stringify(entry)
  ])
  return renderUiShell('Live logs', `
    <section class="panel">
      <h2>${escapeHtml(device.name || device.id)} live logs</h2>
      <p>
        <a href="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(id)}">Back to device</a>
        · <a href="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(id)}/live/logs${logs.lastSeq != null ? `?since=${encodeURIComponent(logs.lastSeq)}` : ''}">Refresh</a>
        · <a href="/plugins/yey-boats-display-manager/devices/${encodeURIComponent(id)}/live/logs">Raw JSON</a>
      </p>
      ${simpleTable(['Seq', 'Time', 'Level', 'Message'], rows, 'No live log entries returned.')}
      <h2>Full log response</h2>
      <pre class="json-block">${escapeHtml(JSON.stringify(logs, null, 2))}</pre>
    </section>`)
}

function renderLiveErrorPage (manager, id, title, err) {
  const device = manager.getDevice(id)
  const message = err && err.payload && err.payload.error
    ? err.payload.error.message
    : err && err.message
      ? err.message
      : 'live device request failed'
  const code = err && err.payload && err.payload.error
    ? err.payload.error.code
    : 'live_request_failed'
  return renderUiShell(title, `
    <section class="panel">
      <h2>${escapeHtml(device.name || device.id)} ${escapeHtml(title.toLowerCase())}</h2>
      <p>
        <a href="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(id)}">Back to device</a>
        · <a href="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(id)}/live/status">Live status</a>
        · <a href="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(id)}/live/logs">Live logs</a>
      </p>
      <table>
        <tbody>
          <tr><th>Status</th><td><span class="status bad">unreachable</span></td></tr>
          <tr><th>Error</th><td>${escapeHtml(code)}</td></tr>
          <tr><th>Message</th><td>${escapeHtml(message)}</td></tr>
          <tr><th>Address source</th><td>${escapeHtml(manager.deviceHttpBase ? 'registered device network identity' : '')}</td></tr>
        </tbody>
      </table>
    </section>`)
}

// Built-in screen ids the firmware renders as fullscreen HUDs (not tile grids).
const FULLSCREEN_SCREEN_IDS = new Set(['autopilot', 'ap_hud', 'wind', 'wind_classic', 'wind_steer', 'knob_wind', 'knob_compass', 'knob_big', 'zoom'])
function screenKindLabel (id) {
  return FULLSCREEN_SCREEN_IDS.has(String(id)) ? 'fullscreen' : 'grid'
}

function saveDeviceConfigForm (manager, id, body) {
  const device = manager.getDevice(id)
  const profileId = String(body.profileId || device.assignedProfile || 'default')
  if (!manager.store.profiles.profiles[profileId]) throw statusError(400, 'unknown preset')
  const overrides = configOverridesFromForm(body)
  let assignedProfile = profileId

  if (body.action === 'save-preset' || body.action === 'save-send-preset') {
    const presetId = sanitizePresetId(body.presetId || body.presetName)
    if (!presetId) throw statusError(400, 'preset id is required')
    const existing = manager.store.profiles.profiles[presetId]
    manager.upsertProfile({
      id: presetId,
      name: body.presetName || presetId,
      version: existing ? Number(existing.version || 1) + 1 : 1,
      config: overrides
    })
    assignedProfile = presetId
  }

  manager.patchDevice(id, {
    assignedProfile,
    overrides
  })

  if (body.action === 'save-send' || body.action === 'save-send-preset') {
    const config = manager.generateConfig(id)
    manager.createCommand(id, {
      type: 'config.reload',
      payload: {
        version: config.version,
        hash: config.hash,
        url: `/plugins/yey-boats-display-manager/devices/${id}/config`
      }
    })
  }

  return { status: body.action || 'saved' }
}

function applyPresetForm (manager, profileId, body) {
  const profile = manager.store.profiles.profiles[profileId]
  if (!profile) throw statusError(404, 'preset not found')
  const deviceIds = arrayValue(body.deviceIds)
  if (deviceIds.length === 0) throw statusError(400, 'select at least one device')

  deviceIds.forEach((deviceId) => {
    manager.assignProfile(deviceId, {
      profileId,
      overrides: checkboxValue(body.clearOverrides) ? {} : manager.getDevice(deviceId).overrides
    })
    if (checkboxValue(body.sendReload)) {
      const config = manager.generateConfig(deviceId)
      manager.createCommand(deviceId, {
        type: 'config.reload',
        payload: {
          version: config.version,
          hash: config.hash,
          url: `/plugins/yey-boats-display-manager/devices/${deviceId}/config`
        }
      })
    }
  })

  return { status: checkboxValue(body.sendReload) ? 'applied-and-sent' : 'applied', count: deviceIds.length }
}

// Per-unit-class number formatting, mirroring the firmware's `ui.format` shape
// (one `{ decimals, si_prefix }` object per physical-quantity class). `decimals`
// is clamped to 0..4; `si_prefix` scales magnitudes >= 1000 to k/M/G. The
// defaults here MUST match the firmware defaults so an unconfigured device and
// the editor agree. Order is the editor's row order.
const FORMAT_UNIT_CLASSES = [
  { key: 'distance', label: 'Distance', decimals: 2, si_prefix: true },
  { key: 'depth', label: 'Depth', decimals: 1, si_prefix: true },
  { key: 'speed', label: 'Speed', decimals: 1, si_prefix: false },
  { key: 'angle', label: 'Angle', decimals: 0, si_prefix: false },
  { key: 'temperature', label: 'Temperature', decimals: 1, si_prefix: false },
  { key: 'voltage', label: 'Voltage', decimals: 2, si_prefix: false },
  { key: 'percent', label: 'Percent', decimals: 0, si_prefix: false }
]

const FORMAT_DECIMALS_MIN = 0
const FORMAT_DECIMALS_MAX = 4

function clampDecimals (value, fallback) {
  const n = integerValue(value, fallback)
  if (n == null) return fallback
  if (n < FORMAT_DECIMALS_MIN) return FORMAT_DECIMALS_MIN
  if (n > FORMAT_DECIMALS_MAX) return FORMAT_DECIMALS_MAX
  return n
}

// Build the `format` object from the config form. Each unit class reads
// `format_<class>_decimals` (clamped 0..4, defaulting to the firmware default)
// and `format_<class>_si` (checkbox). Pure; safe to call with a partial body.
function formatFromForm (body) {
  const out = {}
  for (const cls of FORMAT_UNIT_CLASSES) {
    out[cls.key] = {
      decimals: clampDecimals(body[`format_${cls.key}_decimals`], cls.decimals),
      si_prefix: hasOwn(body, `format_${cls.key}_si`)
        ? checkboxValue(body[`format_${cls.key}_si`])
        : cls.si_prefix
    }
  }
  return out
}

// Normalize a `format` object loaded from a stored/device config into the
// canonical 7-class shape with clamped decimals + boolean si_prefix, filling
// any missing class from the firmware default. Used to validate-on-load so the
// editor always renders a legal form and round-trips cleanly. Pure.
function normalizeFormat (format) {
  const src = format && typeof format === 'object' ? format : {}
  const out = {}
  for (const cls of FORMAT_UNIT_CLASSES) {
    const entry = src[cls.key] && typeof src[cls.key] === 'object' ? src[cls.key] : {}
    out[cls.key] = {
      decimals: clampDecimals(entry.decimals, cls.decimals),
      si_prefix: typeof entry.si_prefix === 'boolean' ? entry.si_prefix : cls.si_prefix
    }
  }
  return out
}

function hasOwn (obj, key) {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key)
}

function configOverridesFromForm (body) {
  const widgets = widgetsFromForm(body)
  const layout = layoutFromForm(body)
  return {
    settings: {
      defaultScreen: cleanString(body.defaultScreen) || 'dashboard',
      theme: cleanString(body.theme) || 'day',
      brightness: numberValue(body.brightness, 0.8),
      demoMode: checkboxValue(body.demoMode),
      format: formatFromForm(body)
    },
    nmea0183Wifi: {
      enabled: checkboxValue(body.nmeaEnabled),
      mode: cleanString(body.nmeaMode) || 'tcp',
      host: cleanString(body.nmeaHost) || 'signalk.local',
      port: integerValue(body.nmeaPort, 10110)
    },
    autopilot: {
      enabled: checkboxValue(body.autopilotEnabled),
      allowEngage: checkboxValue(body.allowEngage),
      allowStandby: checkboxValue(body.allowStandby),
      allowHeadingAdjust: checkboxValue(body.allowHeadingAdjust),
      backend: cleanString(body.autopilotBackend) || 'signalk'
    },
    widgets: {
      defaults: {
        fontSize: integerValue(body.fontSize, 18),
        labelFontSize: integerValue(body.labelFontSize, 12),
        valueFontSize: integerValue(body.valueFontSize, 32),
        unitFontSize: integerValue(body.unitFontSize, 14)
      },
      items: widgets
    },
    layout,
    debug: {
      logLevel: cleanString(body.logLevel) || 'info',
      touchMode: cleanString(body.touchMode) || 'irq'
    }
  }
}

function renderDeviceConfigForm (device, config, profiles, views) {
  const settings = config.settings || {}
  const nmea = config.nmea0183Wifi || {}
  const autopilot = config.autopilot || {}
  const widgets = (config.widgets && config.widgets.defaults) || {}
  const widgetItems = (config.widgets && config.widgets.items) || {}
  const layout = config.layout || {}
  const debug = config.debug || {}
  // Default-screen picker: a dropdown of the device's own reported screens when
  // we have them, so the operator can only pick a screen that actually exists.
  // Falls back to a free-text input when the device is offline / unseen.
  const dvViews = (views && Array.isArray(views.views)) ? views.views : []
  const current = settings.defaultScreen || (views && views.current) || ''
  const defaultScreenField = dvViews.length
    ? select('defaultScreen', current, dvViews.map((v) => [v.id, `${v.title || v.id} (${screenKindLabel(v.id)})`]))
    : input('defaultScreen', current || 'dashboard')
  return `
    <form class="config-form" method="post" action="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(device.id)}/config">
      <h2>Configure device</h2>
      <div class="form-grid">
        ${field('Preset', profileSelect(profiles, device.assignedProfile || config.profile))}
        ${field('Default screen', defaultScreenField)}
        ${field('Theme', select('theme', settings.theme || 'day', [['day', 'Day'], ['night', 'Night'], ['high-contrast', 'High contrast']]))}
        ${field('Brightness', input('brightness', settings.brightness == null ? 0.8 : settings.brightness, 'number', '0', '1', '0.05'))}
        ${field('Demo mode', checkbox('demoMode', settings.demoMode))}
        ${field('NMEA WiFi', checkbox('nmeaEnabled', nmea.enabled))}
        ${field('NMEA mode', select('nmeaMode', nmea.mode || 'tcp', [['tcp', 'TCP'], ['udp', 'UDP']]))}
        ${field('NMEA host', input('nmeaHost', nmea.host || 'signalk.local'))}
        ${field('NMEA port', input('nmeaPort', nmea.port || 10110, 'number', '1', '65535', '1'))}
        ${field('Autopilot', checkbox('autopilotEnabled', autopilot.enabled))}
        ${field('Allow engage', checkbox('allowEngage', autopilot.allowEngage))}
        ${field('Allow standby', checkbox('allowStandby', autopilot.allowStandby))}
        ${field('Heading adjust', checkbox('allowHeadingAdjust', autopilot.allowHeadingAdjust))}
        ${field('AP backend', input('autopilotBackend', autopilot.backend || 'signalk'))}
        ${field('Base font', input('fontSize', widgets.fontSize || 18, 'number', '8', '80', '1'))}
        ${field('Label font', input('labelFontSize', widgets.labelFontSize || 12, 'number', '8', '80', '1'))}
        ${field('Value font', input('valueFontSize', widgets.valueFontSize || 32, 'number', '8', '120', '1'))}
        ${field('Unit font', input('unitFontSize', widgets.unitFontSize || 14, 'number', '8', '80', '1'))}
        ${field('Log level', select('logLevel', debug.logLevel || 'info', [['debug', 'Debug'], ['info', 'Info'], ['warn', 'Warn'], ['error', 'Error']]))}
        ${field('Touch mode', select('touchMode', debug.touchMode || 'irq', [['irq', 'IRQ'], ['poll', 'Poll'], ['disabled', 'Disabled']]))}
      </div>
      ${renderFormatEditor(settings.format)}
      <fieldset class="paths-fields">
        <legend>Paths &amp; fields</legend>
        <p class="muted" style="margin:0 0 10px;">
          Define each tile's widget type and <strong>SignalK path</strong> in
          <em>Widgets</em>, then place those widgets into <strong>screens</strong>
          and tiles below. Both are saved together when you save this form. For
          the manifest-gated drag/drop editor, use the
          <a href="/plugins/yey-boats-display-manager/ui/layout" target="_blank" rel="noopener">layout editor</a>.
        </p>
        ${renderWidgetEditor(widgetItems)}
        ${renderLayoutEditor(layout)}
      </fieldset>
      <fieldset>
        <legend>Save as preset</legend>
        <div class="form-grid">
          ${field('Preset id', input('presetId', ''))}
          ${field('Preset name', input('presetName', ''))}
        </div>
      </fieldset>
      <div class="actions">
        <button type="submit" name="action" value="save">Save device</button>
        <button type="submit" name="action" value="save-send">Save and send to device</button>
        <button type="submit" name="action" value="save-preset">Save as preset</button>
        <button type="submit" name="action" value="save-send-preset">Save preset and send</button>
      </div>
    </form>`
}

// Compact "Number formatting" section: one row per unit class with a decimals
// number input (0..4) and a k/M scaling checkbox. Mirrors the firmware's
// `ui.format`. Loaded values are normalized first so a partial/legacy stored
// config still renders the full 7-class grid with sane defaults.
function renderFormatEditor (format) {
  const fmt = normalizeFormat(format)
  const rows = FORMAT_UNIT_CLASSES.map((cls) => {
    const entry = fmt[cls.key]
    return `
    <tr>
      <td>${escapeHtml(cls.label)}</td>
      <td>${input(`format_${cls.key}_decimals`, entry.decimals, 'number', String(FORMAT_DECIMALS_MIN), String(FORMAT_DECIMALS_MAX), '1')}</td>
      <td><input type="checkbox" name="format_${cls.key}_si" value="1"${entry.si_prefix ? ' checked' : ''}></td>
    </tr>`
  }).join('')
  return `
      <fieldset class="format-fields">
        <legend>Number formatting</legend>
        <p class="muted" style="margin:0 0 10px;">
          Per-unit-class display formatting pushed to the device.
          <strong>Decimals</strong> is the fixed number of fractional digits
          (0–4); <strong>k/M scaling</strong> abbreviates magnitudes ≥ 1000
          (e.g. 1234.5 → 1.23k).
        </p>
        <table>
          <thead><tr><th>Unit class</th><th>Decimals</th><th>k/M scaling</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </fieldset>`
}

function widgetsFromForm (body) {
  const ids = arrayValue(body.widgetId)
  const titles = arrayValue(body.widgetTitle)
  const types = arrayValue(body.widgetType)
  const paths = arrayValue(body.widgetPath)
  const units = arrayValue(body.widgetUnit)
  const precisions = arrayValue(body.widgetPrecision)
  const valueFonts = arrayValue(body.widgetValueFontSize)
  const remove = new Set(arrayValue(body.removeWidget).map(cleanString))
  const items = {}
  ids.forEach((rawId, index) => {
    const id = sanitizeWidgetId(rawId)
    if (!id || remove.has(id)) return
    const type = cleanString(types[index]) || 'numeric'
    const path = cleanString(paths[index])
    if (!path) return
    const widget = {
      type,
      title: cleanString(titles[index]) || id,
      path
    }
    const unit = cleanString(units[index])
    if (unit) widget.unit = unit
    const precision = integerValue(precisions[index], null)
    if (precision != null) widget.precision = precision
    const valueFontSize = integerValue(valueFonts[index], null)
    if (valueFontSize != null) widget.valueFontSize = valueFontSize
    items[id] = widget
  })
  return items
}

function layoutFromForm (body) {
  const screenIds = arrayValue(body.screenId)
  const screenTypes = arrayValue(body.screenType)
  const tileWidgets = arrayValue(body.tileWidget)
  const tileScreens = arrayValue(body.tileScreen)
  const tileCols = arrayValue(body.tileCol)
  const tileRows = arrayValue(body.tileRow)
  const removeTiles = new Set(arrayValue(body.removeTile).map(cleanString))
  const screenById = {}
  screenIds.forEach((rawId, index) => {
    const id = sanitizeWidgetId(rawId)
    if (!id) return
    screenById[id] = {
      id,
      type: cleanString(screenTypes[index]) || 'grid',
      tiles: []
    }
  })
  tileWidgets.forEach((rawWidget, index) => {
    const widget = sanitizeWidgetId(rawWidget)
    const screenId = sanitizeWidgetId(tileScreens[index] || screenIds[0] || 'dashboard')
    if (!widget || !screenId || removeTiles.has(`${screenId}:${widget}:${index}`)) return
    if (!screenById[screenId]) {
      screenById[screenId] = { id: screenId, type: 'grid', tiles: [] }
    }
    const tile = { widget }
    const col = integerValue(tileCols[index], null)
    const row = integerValue(tileRows[index], null)
    if (col != null || row != null) {
      tile.area = {}
      if (col != null) tile.area.col = col
      if (row != null) tile.area.row = row
    }
    screenById[screenId].tiles.push(tile)
  })
  return {
    version: 1,
    screens: Object.values(screenById)
  }
}

function renderWidgetEditor (items) {
  const rows = Object.entries(items || {}).map(([id, widget]) => renderWidgetEditorRow(id, widget))
  rows.push(renderWidgetEditorRow('', {}))
  return `
      <fieldset>
        <legend>Widgets</legend>
        <table>
          <thead><tr><th>ID</th><th>Title</th><th>Type</th><th>SignalK path</th><th>Unit</th><th>Precision</th><th>Value font</th><th>Remove</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </fieldset>`
}

function renderWidgetEditorRow (id, widget) {
  return `
    <tr>
      <td>${input('widgetId', id)}</td>
      <td>${input('widgetTitle', widget.title || '')}</td>
      <td>${select('widgetType', widget.type || 'numeric', widgetTypeOptions())}</td>
      <td>${input('widgetPath', widget.path || '')}</td>
      <td>${input('widgetUnit', widget.unit || '')}</td>
      <td>${input('widgetPrecision', widget.precision == null ? '' : widget.precision, 'number', '0', '6', '1')}</td>
      <td>${input('widgetValueFontSize', widget.valueFontSize == null ? '' : widget.valueFontSize, 'number', '8', '120', '1')}</td>
      <td>${id ? `<input type="checkbox" name="removeWidget" value="${escapeHtml(id)}">` : ''}</td>
    </tr>`
}

function renderLayoutEditor (layout) {
  const screens = Array.isArray(layout.screens) && layout.screens.length
    ? layout.screens
    : [{ id: 'dashboard', type: 'grid', tiles: [] }]
  const screenRows = screens.map((screen) => `
    <tr>
      <td>${input('screenId', screen.id || 'dashboard')}</td>
      <td>${select('screenType', screen.type || 'grid', [['grid', 'Grid']])}</td>
    </tr>`).join('')
  const tileRows = []
  screens.forEach((screen) => {
    ;(screen.tiles || []).forEach((tile, index) => {
      tileRows.push(renderTileEditorRow(screen.id || 'dashboard', tile, index))
    })
  })
  tileRows.push(renderTileEditorRow(screens[0].id || 'dashboard', {}, tileRows.length))
  return `
      <fieldset>
        <legend>Screens</legend>
        <table>
          <thead><tr><th>Screen ID</th><th>Type</th></tr></thead>
          <tbody>${screenRows}</tbody>
        </table>
        <table>
          <thead><tr><th>Screen</th><th>Widget</th><th>Column</th><th>Row</th><th>Remove</th></tr></thead>
          <tbody>${tileRows.join('')}</tbody>
        </table>
      </fieldset>`
}

function renderTileEditorRow (screenId, tile, index) {
  const area = tile.area || {}
  const removeValue = `${screenId}:${tile.widget || ''}:${index}`
  return `
    <tr>
      <td>${input('tileScreen', screenId || 'dashboard')}</td>
      <td>${input('tileWidget', tile.widget || '')}</td>
      <td>${input('tileCol', area.col == null ? '' : area.col, 'number', '0', '15', '1')}</td>
      <td>${input('tileRow', area.row == null ? '' : area.row, 'number', '0', '15', '1')}</td>
      <td>${tile.widget ? `<input type="checkbox" name="removeTile" value="${escapeHtml(removeValue)}">` : ''}</td>
    </tr>`
}

function widgetTypeOptions () {
  return [
    ['numeric', 'Numeric'],
    ['text', 'Text'],
    ['bar', 'Bar'],
    ['gauge', 'Gauge'],
    ['compass', 'Compass'],
    ['windRose', 'Wind rose'],
    ['trend', 'Trend'],
    ['button', 'Button'],
    ['autopilot', 'Autopilot']
  ]
}

function field (labelText, control) {
  return `<label>${escapeHtml(labelText)}${control}</label>`
}

function input (name, value, type, min, max, step) {
  const attrs = [
    `type="${escapeHtml(type || 'text')}"`,
    `name="${escapeHtml(name)}"`,
    `value="${escapeHtml(value)}"`
  ]
  if (min != null) attrs.push(`min="${escapeHtml(min)}"`)
  if (max != null) attrs.push(`max="${escapeHtml(max)}"`)
  if (step != null) attrs.push(`step="${escapeHtml(step)}"`)
  return `<input ${attrs.join(' ')}>`
}

function checkbox (name, checked) {
  return `<span><input type="checkbox" name="${escapeHtml(name)}" value="1"${checked ? ' checked' : ''}>enabled</span>`
}

function select (name, value, options) {
  return `<select name="${escapeHtml(name)}">${options.map(([optionValue, label]) => {
    const selected = String(optionValue) === String(value) ? ' selected' : ''
    return `<option value="${escapeHtml(optionValue)}"${selected}>${escapeHtml(label)}</option>`
  }).join('')}</select>`
}

function profileSelect (profiles, selectedProfile) {
  return select('profileId', selectedProfile || 'default', profiles.map((profile) => [
    profile.id,
    `${profile.name || profile.id} (${profile.id})`
  ]))
}

function cleanString (value) {
  return String(value == null ? '' : value).trim()
}

function checkboxValue (value) {
  return value === '1' || value === 'on' || value === true
}

function arrayValue (value) {
  if (Array.isArray(value)) return value.filter((item) => item != null && item !== '')
  if (value == null || value === '') return []
  return [value]
}

function numberValue (value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function integerValue (value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function sanitizePresetId (value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function sanitizeWidgetId (value) {
  return cleanString(value)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31)
}

function statusError (status, message) {
  const err = new Error(message)
  err.status = status
  err.payload = { error: { code: 'invalid_request', message } }
  return err
}

function toYaml (value, indent = 0) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]\n'
    return value.map((item) => {
      if (item && typeof item === 'object') {
        return `${pad}-\n${toYaml(item, indent + 2)}`
      }
      return `${pad}- ${yamlScalar(item)}\n`
    }).join('')
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) return '{}\n'
    return keys.map((key) => {
      const item = value[key]
      if (item && typeof item === 'object') {
        return `${pad}${key}:\n${toYaml(item, indent + 2)}`
      }
      return `${pad}${key}: ${yamlScalar(item)}\n`
    }).join('')
  }
  return `${pad}${yamlScalar(value)}\n`
}

function yamlScalar (value) {
  if (value == null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const s = String(value)
  if (/^[A-Za-z0-9_.:/@-]+$/.test(s) && !['true', 'false', 'null'].includes(s)) return s
  return JSON.stringify(s)
}

function fromYaml (text) {
  const lines = text.split(/\r?\n/)
    .map((raw) => ({ raw, indent: raw.match(/^ */)[0].length, text: raw.trim() }))
    .filter((line) => line.text && !line.text.startsWith('#'))
  const [value] = parseYamlBlock(lines, 0, 0)
  return value
}

function parseYamlBlock (lines, index, indent) {
  if (index >= lines.length) return [{}, index]
  if (lines[index].text.startsWith('-')) return parseYamlArray(lines, index, indent)
  return parseYamlObject(lines, index, indent)
}

function parseYamlObject (lines, index, indent) {
  const out = {}
  while (index < lines.length) {
    const line = lines[index]
    if (line.indent < indent || line.text.startsWith('-')) break
    if (line.indent > indent) throw statusError(400, 'invalid dashboard YAML indentation')
    const split = line.text.indexOf(':')
    if (split <= 0) throw statusError(400, 'invalid dashboard YAML mapping')
    const key = line.text.slice(0, split).trim()
    const rest = line.text.slice(split + 1).trim()
    if (rest) {
      out[key] = parseYamlScalar(rest)
      index++
    } else {
      const parsed = parseYamlBlock(lines, index + 1, indent + 2)
      out[key] = parsed[0]
      index = parsed[1]
    }
  }
  return [out, index]
}

function parseYamlArray (lines, index, indent) {
  const out = []
  while (index < lines.length) {
    const line = lines[index]
    if (line.indent < indent || !line.text.startsWith('-')) break
    if (line.indent > indent) throw statusError(400, 'invalid dashboard YAML indentation')
    const rest = line.text.slice(1).trim()
    if (rest) {
      out.push(parseYamlScalar(rest))
      index++
    } else {
      const parsed = parseYamlBlock(lines, index + 1, indent + 2)
      out.push(parsed[0])
      index = parsed[1]
    }
  }
  return [out, index]
}

function parseYamlScalar (value) {
  if (value === 'null') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))) {
    try {
      return JSON.parse(value.startsWith('"') ? value : JSON.stringify(value.slice(1, -1)))
    } catch (err) {
      return value.slice(1, -1)
    }
  }
  if (value === '[]') return []
  if (value === '{}') return {}
  return value
}

function renderDeviceConfigWidget (config, views) {
  const services = (((config.network || {}).mdns || {}).services || [])
    .map((service) => `${service.type}:${service.port}`)
    .join(', ')
  return `
    <div class="config-grid">
      ${configSection('Config', keyValueTable([
        ['Profile', config.profile],
        ['Version', config.version],
        ['Hash', code(config.hash)],
        ['Generated', config.generatedAt]
      ]))}
      ${configSection('Display', keyValueTable([
        ['Size', `${valueOr(config.display && config.display.width, '?')}x${valueOr(config.display && config.display.height, '?')}`],
        ['Shape', config.display && config.display.shape],
        ['Rotation', config.display && config.display.rotation],
        ['Selected variant', config.display && config.display.selectedVariant]
      ]))}
      ${configSection('Settings', keyValueTable([
        ['Default screen', config.settings && config.settings.defaultScreen],
        ['Theme', config.settings && config.settings.theme],
        ['Brightness', config.settings && config.settings.brightness],
        ['Demo mode', yesNo(config.settings && config.settings.demoMode)]
      ]))}
      ${configSection('Network', keyValueTable([
        ['Hostname', config.network && config.network.hostname],
        ['Domain', config.network && config.network.domain],
        ['FQDN', config.network && config.network.fqdn],
        ['mDNS', yesNo(config.network && config.network.mdns && config.network.mdns.enabled)],
        ['Services', services || 'none']
      ]))}
      ${configSection('SignalK and NMEA', keyValueTable([
        ['SignalK host', config.signalk && `${config.signalk.host}:${config.signalk.port}`],
        ['SignalK mDNS', yesNo(config.signalk && config.signalk.useMdns)],
        ['Source priority', config.sources && Array.isArray(config.sources.priority) ? config.sources.priority.join(', ') : ''],
        ['NMEA 0183 WiFi', nmeaLabel(config.nmea0183Wifi)]
      ]))}
      ${configSection('Device Web API', keyValueTable([
        ['Basic auth', yesNo(config.webAuth && config.webAuth.enabled)],
        ['Username', config.webAuth && config.webAuth.username],
        ['Password set', yesNo(config.webAuth && config.webAuth.password)]
      ]))}
      ${configSection('OTA', keyValueTable([
        ['Enabled', yesNo(config.ota && config.ota.enabled)],
        ['Mode', config.ota && config.ota.mode],
        ['Address', config.ota && `${config.ota.address}:${config.ota.port}`],
        ['Password set', yesNo(config.ota && config.ota.passwordSet)]
      ]))}
      ${configSection('Autopilot', keyValueTable([
        ['Enabled', yesNo(config.autopilot && config.autopilot.enabled)],
        ['Backend', config.autopilot && config.autopilot.backend],
        ['Engage allowed', yesNo(config.autopilot && config.autopilot.allowEngage)],
        ['Standby allowed', yesNo(config.autopilot && config.autopilot.allowStandby)],
        ['Heading adjust', yesNo(config.autopilot && config.autopilot.allowHeadingAdjust)]
      ]))}
      ${configSection('Debug', keyValueTable([
        ['Log level', config.debug && config.debug.logLevel],
        ['Touch mode', config.debug && config.debug.touchMode],
        ['Heartbeat', config.management && `${config.management.heartbeatMs} ms`],
        ['Command poll', config.management && `${config.management.commandPollMs} ms`]
      ]))}
      ${configSection('Widgets', renderWidgetsTable(config.widgets), true)}
      ${configSection('Screens', renderScreensTable(config.layout, views), true)}
    </div>`
}

function configSection (title, body, full) {
  return `<section class="config-section${full ? ' full' : ''}"><h2>${escapeHtml(title)}</h2>${body}</section>`
}

function keyValueTable (rows) {
  return `<table><tbody>${rows.map(([key, value]) => `
    <tr><th>${escapeHtml(key)}</th><td>${formatConfigValue(value)}</td></tr>`).join('')}</tbody></table>`
}

function simpleTable (headers, rows, emptyMessage) {
  const body = rows && rows.length
    ? rows.map((row) => `<tr>${row.map((value) => `<td>${formatConfigValue(value)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}">${escapeHtml(emptyMessage || 'No rows.')}</td></tr>`
  return `
    <table>
      <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>
    </table>`
}

function renderWidgetsTable (widgets) {
  const items = widgets && widgets.items ? Object.entries(widgets.items) : []
  const rows = items.map(([id, widget]) => `
    <tr>
      <td><strong>${escapeHtml(widget.title || id)}</strong><br><span>${escapeHtml(id)}</span></td>
      <td><span class="pill">${escapeHtml(widget.type || '')}</span></td>
      <td>${escapeHtml(widget.path || '')}</td>
      <td>${fontSummary(widget)}</td>
    </tr>`).join('')
  const defaults = widgets && widgets.defaults ? `Defaults: ${escapeHtml(fontSummary(widgets.defaults))}` : ''
  return `
    <p class="muted">Variant ${escapeHtml(widgets && widgets.variant ? widgets.variant : 'default')}. ${defaults}</p>
    <table>
      <thead><tr><th>Widget</th><th>Type</th><th>SignalK path</th><th>Fonts</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No widgets selected for this device.</td></tr>'}</tbody>
    </table>`
}

function renderScreensTable (layout, views) {
  // Prefer the device's own reported screens (heartbeat ui.screens) so the list
  // reflects what the firmware actually renders, not the manager's generated
  // preset catalogue. Fall back to the generated layout when offline.
  const dvViews = (views && Array.isArray(views.views)) ? views.views : []
  if (dvViews.length) {
    const current = views.current
    const rows = dvViews.map((v) => `
      <tr>
        <td><strong>${escapeHtml(v.title || v.id)}</strong><br><span>${escapeHtml(v.id)}</span></td>
        <td><span class="pill">${escapeHtml(screenKindLabel(v.id))}</span></td>
        <td>${v.id === current ? '<span class="status good">on device</span>' : ''}</td>
      </tr>`).join('')
    return `
      <p class="muted">Discovered from the device (${dvViews.length} switchable screen${dvViews.length === 1 ? '' : 's'}). Built-in screens are rendered by the firmware.</p>
      <table>
        <thead><tr><th>Screen</th><th>Type</th><th>Current</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }
  const screens = layout && Array.isArray(layout.screens) ? layout.screens : []
  const rows = screens.map((screen) => {
    const tiles = Array.isArray(screen.tiles) ? screen.tiles : []
    return `
      <tr>
        <td><strong>${escapeHtml(screen.id || '')}</strong><br><span>${escapeHtml(screen.type || '')}</span></td>
        <td>${escapeHtml(tiles.length)}</td>
        <td>${escapeHtml(tiles.map((tile) => tile.widget).filter(Boolean).join(', '))}</td>
      </tr>`
  }).join('')
  return `
    <p class="muted">Device offline — showing the manager's generated layout (variant ${escapeHtml(layout && layout.variant ? layout.variant : 'default')}).</p>
    <table>
      <thead><tr><th>Screen</th><th>Tiles</th><th>Widgets</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">No screens selected for this device.</td></tr>'}</tbody>
    </table>`
}

function formatConfigValue (value) {
  if (value && value.__html) return value.__html
  if (Array.isArray(value)) return escapeHtml(value.join(', '))
  if (value == null || value === '') return '<span class="muted">unset</span>'
  return escapeHtml(value)
}

function code (value) {
  return { __html: `<code>${escapeHtml(value)}</code>` }
}

function valueOr (value, fallback) {
  return value == null || value === '' ? fallback : value
}

function yesNo (value) {
  return value ? 'yes' : 'no'
}

function nmeaLabel (nmea) {
  if (!nmea) return 'disabled'
  return `${nmea.enabled ? 'enabled' : 'disabled'} ${nmea.mode || ''} ${nmea.host || ''}:${nmea.port || ''}`.trim()
}

function fontSummary (settings) {
  return ['fontSize', 'labelFontSize', 'valueFontSize', 'unitFontSize', 'titleFontSize', 'buttonFontSize']
    .filter((key) => settings && settings[key] != null)
    .map((key) => `${key.replace('FontSize', '')}: ${settings[key]}`)
    .join(', ') || 'defaults'
}

function renderDiscoveryScanForm () {
  return `
      <form class="config-form" method="post" action="/plugins/yey-boats-display-manager/discovery/scan">
        <fieldset>
          <legend>Scan network</legend>
          <div class="form-grid">
            ${field('Method', select('method', 'ip', [['ip', 'IP'], ['ble', 'BLE']]))}
            ${field('Target', input('target', ''))}
            ${field('Ports', input('ports', '80'))}
            ${field('Timeout ms', input('timeoutMs', '900', 'number', '250', '5000', '50'))}
          </div>
          <div class="actions">
            <button type="submit" name="action" value="scan">Scan</button>
          </div>
        </fieldset>
      </form>`
}

function renderDiscoveryClaimControl (device, profiles) {
  if (device.registered) {
    return `<a href="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(device.deviceId)}">Open</a>`
  }
  // Staleness no longer blocks claiming — a discovered device is shown and
  // claimable regardless of age (pending is stateless). Only a genuinely
  // unusable target (missing address, or an unresolved address conflict)
  // disables the claim button.
  const blocked = []
  if (device.conflict) blocked.push('address conflict')
  if (!device.address) blocked.push('missing address')
  if (blocked.length) {
    return `
    <form method="post" action="/plugins/yey-boats-display-manager/discovery/devices/${encodeURIComponent(device.deviceId)}/claim">
      ${profileSelect(profiles, 'default')}
      <button type="submit" class="btn-sm" disabled>Claim</button>
      <span class="muted">Resolve ${escapeHtml(blocked.join(', '))} before claiming.</span>
    </form>`
  }
  return `
    <form method="post" action="/plugins/yey-boats-display-manager/discovery/devices/${encodeURIComponent(device.deviceId)}/claim">
      <input type="hidden" name="role" value="${escapeHtml(device.role || 'display')}">
      <input type="hidden" name="location" value="${escapeHtml(device.location || '')}">
      <input type="hidden" name="sendReload" value="1">
      ${profileSelect(profiles, 'default')}
      <button type="submit" class="btn-sm">Claim</button>
    </form>`
}

function renderProfilesPage (profiles, devices) {
  const rows = profiles.map((profile) => `
        <tr>
          <td><strong><a href="/plugins/yey-boats-display-manager/ui/profiles/${encodeURIComponent(profile.id)}">${escapeHtml(profile.name || profile.id)}</a></strong><br><span>${escapeHtml(profile.id)}</span></td>
          <td>${escapeHtml(profile.version)}</td>
          <td>${escapeHtml(profile.updatedAt || '')}</td>
          <td>${escapeHtml(devices.filter((device) => device.profile === profile.id).length)}</td>
          <td>${escapeHtml(configSummary(profile.config || {}))}</td>
          <td><code>${escapeHtml(profile.hash || '')}</code><br><span><a href="/plugins/yey-boats-display-manager/profiles/${encodeURIComponent(profile.id)}/dashboard.json">json</a> · <a href="/plugins/yey-boats-display-manager/profiles/${encodeURIComponent(profile.id)}/dashboard.yaml">yaml</a></span></td>
        </tr>`).join('')
  return `
    <section class="panel">
      <h2>Device presets</h2>
      <p class="muted">Presets are shared profiles. Assign them from a device config page, then save per-device overrides or save changes back as a new preset.</p>
      <form class="config-form" method="post" action="/plugins/yey-boats-display-manager/profiles/import-dashboard">
        <h2>Import dashboard preset</h2>
        <div class="form-grid">
          ${field('Preset id', input('presetId', 'imported-dashboard'))}
          ${field('Format', select('format', 'json', [['json', 'JSON'], ['yaml', 'YAML']]))}
        </div>
        <textarea name="raw" rows="10" placeholder="Paste yeyboats.dashboard.v2 JSON or YAML here"></textarea>
        <div class="actions"><button type="submit">Import preset</button></div>
      </form>
      <table>
        <thead><tr><th>Preset</th><th>Version</th><th>Updated</th><th>Devices</th><th>Summary</th><th>Hash</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6">No presets configured.</td></tr>'}</tbody>
      </table>
    </section>`
}

function renderPresetPage (manager, profileId, devices) {
  const profile = manager.store.profiles.profiles[profileId]
  if (!profile) throw statusError(404, 'preset not found')
  const assigned = devices.filter((device) => device.profile === profile.id)
  const rows = devices.map((device) => {
    const checked = device.profile === profile.id ? ' checked' : ''
    return `
      <tr>
        <td><input type="checkbox" name="deviceIds" value="${escapeHtml(device.id)}"${checked}></td>
        <td><strong><a href="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(device.id)}/config">${escapeHtml(device.name || device.id)}</a></strong><br><span>${escapeHtml(device.id)}</span></td>
        <td>${escapeHtml(device.profile)}</td>
        <td>${escapeHtml(`${device.display.width}x${device.display.height}`)}</td>
        <td>${device.configDrift ? 'yes' : 'no'}</td>
        <td>${device.pendingCommands}</td>
      </tr>`
  }).join('')
  return `
    <section class="panel">
      <h2>${escapeHtml(profile.name || profile.id)}</h2>
      <p class="muted">${escapeHtml(profile.id)} · version ${escapeHtml(profile.version)} · ${escapeHtml(assigned.length)} device(s)</p>
      <p><a href="/plugins/yey-boats-display-manager/ui/profiles">Back to presets</a></p>
      <table>
        <tbody>
          <tr><th>Updated</th><td>${escapeHtml(profile.updatedAt || '')}</td></tr>
          <tr><th>Summary</th><td>${escapeHtml(configSummary(profile.config || {}))}</td></tr>
          <tr><th>Hash</th><td><code>${escapeHtml(profile.hash || '')}</code></td></tr>
        </tbody>
      </table>
      <form class="config-form" method="post" action="/plugins/yey-boats-display-manager/ui/profiles/${encodeURIComponent(profile.id)}/apply">
        <h2>Apply preset</h2>
        <table>
          <thead><tr><th></th><th>Device</th><th>Current preset</th><th>Display</th><th>Drift</th><th>Pending</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6">No devices registered.</td></tr>'}</tbody>
        </table>
        <fieldset>
          <legend>Apply options</legend>
          <div class="form-grid">
            ${field('Clear device overrides', checkbox('clearOverrides', true))}
            ${field('Send reload command', checkbox('sendReload', true))}
          </div>
        </fieldset>
        <div class="actions">
          <button type="submit">Apply to selected devices</button>
        </div>
      </form>
    </section>`
}

function configSummary (config) {
  const parts = []
  if (config.settings && config.settings.theme) parts.push(`theme ${config.settings.theme}`)
  if (config.settings && config.settings.brightness != null) parts.push(`brightness ${config.settings.brightness}`)
  if (config.widgets && config.widgets.defaults && config.widgets.defaults.valueFontSize) parts.push(`value font ${config.widgets.defaults.valueFontSize}`)
  if (config.nmea0183Wifi) parts.push(`NMEA ${config.nmea0183Wifi.enabled ? 'on' : 'off'}`)
  return parts.join(', ') || 'base layout'
}

function renderFirmwarePage (catalog, jobs, upgrades) {
  const artifactRows = (catalog.artifacts || []).map((artifact) => `
        <tr>
          <td><strong>${escapeHtml(artifact.firmware && artifact.firmware.version)}</strong><br><span>${escapeHtml(artifact.artifactId)}</span></td>
          <td>${escapeHtml(artifact.vendor && artifact.vendor.id)}</td>
          <td>${escapeHtml(artifact.product && artifact.product.id)}</td>
          <td>${escapeHtml(firmwareSourceLabel(artifact))}</td>
          <td><code>${escapeHtml(artifact.file && artifact.file.sha256)}</code></td>
          <td>
            <!-- Same JS-attribute-context XSS risk as the device Remove
                 button above. Firmware version + artifactId come from
                 GitHub release metadata in the common case but the
                 catalogue also accepts operator-uploaded artifacts
                 with arbitrary version strings, so we can't trust them
                 inside an inline onsubmit. Static prompt; the row
                 itself shows which artifact is being deleted. -->
            <form method="post" action="/plugins/yey-boats-display-manager/ui/firmware/artifacts/${encodeURIComponent(artifact.artifactId)}/delete"
                  onsubmit="return confirm('Remove this artifact from catalogue?')"
                  style="margin:0;display:inline;">
              <button type="submit" style="background:#c0392b;border-color:#a82716;">Delete</button>
            </form>
          </td>
        </tr>`).join('')
  const upgradeRows = ((upgrades && upgrades.devices) || []).map((device) => {
    const versions = device.compatibleArtifacts.length > 0
      ? device.compatibleArtifacts.map((artifact) => {
          const version = artifact.firmware && artifact.firmware.version ? artifact.firmware.version : artifact.artifactId
          const marker = artifact.sameVersion ? ' current' : ''
          return `<span class="pill">${escapeHtml(`${version}${marker} · ${firmwareSourceLabel(artifact)}`)}</span>`
        }).join(' ')
      : '<span>None for this board/chip.</span>'
    const action = device.availableArtifacts.length > 0
      ? device.availableArtifacts.map((artifact) => `
          <form method="post" action="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(device.deviceId)}/firmware/update" style="display:inline-block; margin:0 6px 6px 0;">
            <input type="hidden" name="artifactId" value="${escapeHtml(artifact.artifactId)}">
            <input type="hidden" name="reboot" value="true">
            <input type="hidden" name="confirmAfterBoot" value="true">
            <button type="submit">Queue update ${escapeHtml(artifact.firmware && artifact.firmware.version)}</button>
          </form>`).join('')
      : '<span>No update action.</span>'
    const jobText = device.activeJobs.length > 0
      ? `<br><span>${escapeHtml(device.activeJobs.length)} active firmware job(s)</span>`
      : ''
    return `
        <tr>
          <td><strong><a href="/plugins/yey-boats-display-manager/ui/devices/${encodeURIComponent(device.deviceId)}">${escapeHtml(device.name)}</a></strong><br><span>${escapeHtml(device.deviceId)}</span></td>
          <td>${escapeHtml(device.board || '')}<br><span>${escapeHtml(device.chip || '')}</span></td>
          <td>${escapeHtml(device.currentVersion || 'unknown')}</td>
          <td>${versions}</td>
          <td><span class="status ${device.upgradable ? 'ok' : ''}">${escapeHtml(device.status)}</span>${jobText}</td>
          <td>${action}</td>
        </tr>`
  }).join('')
  const github = catalog.github || {}
  return `
    <section class="panel">
      <h2>Device upgrade status</h2>
      <form method="post" action="/plugins/yey-boats-display-manager/ui/firmware/catalog/refresh" class="actions" style="margin-bottom: 12px;">
        <button type="submit">Refresh catalog from GitHub</button>
        <span class="muted">Last GitHub check: ${escapeHtml(github.checkedAt || 'never')} · release ${escapeHtml(github.release || 'unknown')}</span>
      </form>
      <table>
        <thead><tr><th>Device</th><th>Board</th><th>Current firmware</th><th>Available versions</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${upgradeRows || '<tr><td colspan="6">No devices registered.</td></tr>'}</tbody>
      </table>
      <h2>Firmware catalogue (${(catalog.artifacts || []).length})</h2>
      <p class="muted">Build artefacts available for OTA. Use Delete to remove an old version from this catalogue (does not delete the binary; active jobs keep running).</p>
      <table>
        <thead><tr><th>Firmware</th><th>Vendor</th><th>Product</th><th>Source</th><th>SHA-256</th><th></th></tr></thead>
        <tbody>${artifactRows || '<tr><td colspan="6">No firmware artifacts.</td></tr>'}</tbody>
      </table>
      <h2>Recent jobs</h2>
      ${firmwareJobTable(jobs || [])}
    </section>`
}

function commandTable (commands) {
  const rows = commands.map((command) => `
        <tr>
          <td><code>${escapeHtml(command.id)}</code></td>
          <td>${escapeHtml(command.type)}</td>
          <td>${escapeHtml(command.status)}</td>
          <td>${escapeHtml(command.createdAt)}</td>
        </tr>`).join('')
  return `<table><thead><tr><th>ID</th><th>Type</th><th>Status</th><th>Created</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No commands.</td></tr>'}</tbody></table>`
}

function firmwareJobTable (jobs) {
  const rows = jobs.map((job) => `
        <tr>
          <td><code>${escapeHtml(job.jobId)}</code></td>
          <td>${escapeHtml(job.deviceId)}</td>
          <td>${escapeHtml(job.artifactId)}</td>
          <td>${escapeHtml(job.status)}</td>
          <td>${escapeHtml(job.createdAt)}</td>
        </tr>`).join('')
  return `<table><thead><tr><th>Job</th><th>Device</th><th>Artifact</th><th>Status</th><th>Created</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No firmware jobs.</td></tr>'}</tbody></table>`
}

function renderSettingsPage (manager, req) {
  const s = manager.getSettingsMasked()
  const saved = req && req.query && req.query.saved
  const prefix = s.numbering.prefix || ''
  const pad = s.numbering.pad || 0
  const next = s.numbering.next || 1
  const preview = `${prefix}${String(next).padStart(pad, '0')}`
  const passwordInput = (name, isSet) =>
    `<input type="password" name="${escapeHtml(name)}" value=""${isSet ? ' placeholder="(unchanged)"' : ''}>`
  return `
    <form class="config-form" method="post" action="/plugins/yey-boats-display-manager/ui/settings">
      <h2>System settings</h2>
      ${saved ? '<p class="muted">Saved.</p>' : ''}
      <fieldset>
        <legend>Network / WiFi</legend>
        <div class="form-grid">
          ${field('WiFi SSID', input('ssid', s.network.ssid))}
          ${field('WiFi password', passwordInput('network_password', s.network.passwordSet))}
          ${field('mDNS domain', input('mdnsDomain', s.network.mdnsDomain))}
        </div>
      </fieldset>
      <fieldset>
        <legend>OTA</legend>
        <div class="form-grid">
          ${field('OTA password', passwordInput('ota_password', s.ota.passwordSet))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Device numbering</legend>
        <div class="form-grid">
          ${field('Prefix', input('prefix', prefix))}
          ${field('Pad', input('pad', pad, 'number', '0', '8', '1'))}
          ${field('Next', input('next', next, 'number', '1', null, '1'))}
        </div>
        <p class="muted">Next device name: <code>${escapeHtml(preview)}</code></p>
      </fieldset>
      <div class="actions">
        <button type="submit">Save settings</button>
      </div>
    </form>`
}

function nav (active) {
  // Reorganised 2026-06-04: discovery folded into devices, layout
  // editor surfaced as a top-level nav item. Editor link uses the
  // /plugins/.../ui/layout route which serves the editor INSIDE
  // the same iframe shell as the rest of the UI - linking directly
  // to /yey-boats-display-manager/layout-editor.html would break out
  // of the iframe and confuse the SK admin sidebar's "back to
  // plugin" affordance.
  // Presets, Layout editor, and Overview dropped from the nav (2026-06).
  // Overview merged into the Devices home page; the /ui/profiles and
  // /ui/layout routes stay defined and reachable, just not surfaced here.
  const items = [
    ['devices', '/plugins/yey-boats-display-manager/ui', 'Devices'],
    ['firmware', '/plugins/yey-boats-display-manager/ui/firmware', 'Firmware'],
    ['settings', '/plugins/yey-boats-display-manager/ui/settings', 'Settings']
  ]
  return `<nav>${items.map(([id, href, label]) => `<a class="${active === id ? 'active' : ''}" href="${href}">${label}</a>`).join('')}</nav>`
}

function displayLabel (display) {
  if (!display) return ''
  return `${display.width || '?'}x${display.height || '?'}${display.shape ? ` ${display.shape}` : ''}`
}

function firmwareLabel (firmware) {
  if (!firmware) return ''
  return firmware.version || firmware.name || firmware.id || 'custom firmware'
}

// Human "x ago" string for a last-seen timestamp. Purely informational —
// the device list never hides or disables a row based on age.
function relativeTime (iso) {
  if (!iso) return 'never'
  const ms = Date.parse(iso)
  if (!ms) return 'never'
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const s = Math.round(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function firmwareSourceLabel (artifact) {
  if (artifact && artifact.file && artifact.file.url) return 'GitHub'
  if (artifact && artifact.file && artifact.file.path) return 'SignalK'
  return 'SignalK metadata'
}

function metric (value, label) {
  return `<div class="metric"><b>${value}</b><span>${escapeHtml(label)}</span></div>`
}

function escapeHtml (value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Opt-in SignalK meta write-back for "save limits". Emits a SignalK `meta`
// delta (displayScale + zones) onto the bound path so the source and other
// clients share the operator's configured limits. Best-effort: resolves on a
// successful emit, rejects when the SignalK app can't accept it (caller maps
// the rejection to metaWriteBack:'failed' and still persists onto the field).
function writeSignalKMeta (manager, path, limits) {
  return new Promise((resolve, reject) => {
    const app = manager && manager.app
    if (!app || typeof app.handleMessage !== 'function') {
      return reject(new Error('signalk_app_unavailable'))
    }
    const value = {}
    if (limits && limits.range && typeof limits.range.min === 'number' && typeof limits.range.max === 'number') {
      value.displayScale = { lower: limits.range.min, upper: limits.range.max }
    }
    if (limits && Array.isArray(limits.zones) && limits.zones.length) {
      value.zones = limits.zones
    }
    if (!Object.keys(value).length) return reject(new Error('no_limits_to_write'))
    try {
      app.handleMessage('yey-boats-display-manager', {
        updates: [{ meta: [{ path: String(path), value }] }]
      })
      resolve()
    } catch (e) {
      reject(e)
    }
  })
}

module.exports._test = {
  toYaml,
  fromYaml,
  renderUi,
  importDashboardPreset,
  applyPresetForm,
  configOverridesFromForm,
  formatFromForm,
  normalizeFormat,
  FORMAT_UNIT_CLASSES,
  applyScreenEdits,
  registerRoutes
}

module.exports.__renderHomePage = renderHomePage
module.exports.__nav = nav
module.exports.__renderSettingsPage = renderSettingsPage
module.exports.__renderDevicePage = renderDevicePage
