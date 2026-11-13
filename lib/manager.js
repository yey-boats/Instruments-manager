const dgram = require('dgram')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { JsonStore } = require('./store')
const { DeviceSecretStore, LEGACY_SHARED_WEB_PASSWORD } = require('./device-secrets')
const { ManagerApiTokenStore } = require('./manager-api-token')
const { ProtoControl } = require('./proto-control')
const fieldSchema = require('./field-schema')
const midlLib = require('./midl')

// Firmware manager_config.h MAX_WIDGETS: widget items per pushed config.
const MAX_DEVICE_WIDGETS = 32
const {
  now,
  randomId,
  sha256Json,
  clone,
  sanitizeDeviceId,
  hostnameFromPolicy,
  mergeDeep
} = require('./util')

const PROTOCOL = 'yeyboats.management.v2'

// instruments-manager#23: the public string every pre-#23 install accepted as
// its manager API token (and the firmware's compiled-in bootstrap token). It
// is only honoured in the explicit dev auth mode; otherwise it marks devices
// that still need migrating to a per-device token.
const LEGACY_DEV_TOKEN = 'yeyboats-dev'
// PR #27 review: at most one firmware-change re-push per display per window;
// finished commands are kept for a day, at most FINISHED_COMMANDS_PER_DEVICE.
const FIRMWARE_REPUSH_INTERVAL_MS = 10 * 60 * 1000
const FINISHED_COMMAND_TTL_MS = 24 * 60 * 60 * 1000
const FINISHED_COMMANDS_PER_DEVICE = 50
const LEGACY_DEFAULT_PROVISION_TOKEN = 'yeyboats-provision'
// Auth modes that are only available behind the dev flag
// (YEYBOATS_MANAGER_DEV_AUTH=1, passed in as options.auth.devAuth).
const DEV_AUTH_MODES = ['dev-shared-token', 'disabled']
// #25: limits for unauthenticated sightings / failed sign-in audit lines.
const SIGHTING_WINDOW_MS = 60 * 1000
const SIGHTINGS_PER_ADDRESS_PER_WINDOW = 5
const MAX_ANONYMOUS_SIGHTINGS = 64
// PR #28 review: fairness. New ids from an address not yet heard this window
// draw from FIRST_SIGHTINGS_PER_WINDOW; further new ids from the same address
// from the smaller REPEAT_SIGHTINGS_PER_WINDOW, at most
// NEW_IDS_PER_ADDRESS_PER_WINDOW each. Refreshes of an existing record only
// spend the per-address budget. One address keeps at most
// MAX_SIGHTINGS_PER_ADDRESS records; eviction takes from the address holding
// the most, so each address keeps its newest record.
const FIRST_SIGHTINGS_PER_WINDOW = 30
const REPEAT_SIGHTINGS_PER_WINDOW = 10
const NEW_IDS_PER_ADDRESS_PER_WINDOW = 2
const MAX_SIGHTINGS_PER_ADDRESS = 4
const SIGHTING_STALE_MS = 10 * 60 * 1000
// #29: addresses kept per anonymously sighted id. PR #30 review: none is
// evicted; further addresses are refused and counted (refusedAddresses).
const MAX_ADDRESSES_PER_SIGHTING = 8
const LOGIN_FAILURE_AUDITS_PER_WINDOW = 10
// Retry a failed token delivery at most this often (per device).
const TOKEN_PUSH_RETRY_MS = 60000
const SIGNALK_DISCOVERY_QUERY = 'yeyboats.signalk.discover.v2'
const SIGNALK_DISCOVERY_PROTOCOL = 'yeyboats.signalk.discovery.v2'
const DEVICE_ANNOUNCE_PROTOCOL = 'yeyboats.device.announce.v2'
// Standard known view ids a display falls back to when it has no stored
// screen list yet (e.g. freshly registered, layout not seeded). Mirrors the
// default preset screen ids so the knob's Select-View menu is never empty.
const KNOWN_VIEW_IDS = ['dashboard', 'wind', 'nav', 'depth', 'autopilot', 'system']
const KNOWN_VIEW_TITLES = {
  dashboard: 'Dashboard',
  wind: 'Wind',
  nav: 'Nav',
  depth: 'Depth',
  autopilot: 'Autopilot',
  system: 'System'
}
const YEYBOATS_MDNS_SERVICE = '_yeyboats._tcp.local'
const YEYBOATS_MGMT_MDNS_SERVICE = '_yeyboats-mgmt._tcp.local'
const MDNS_MULTICAST = '224.0.0.251'
const MDNS_PORT = 5353
const SUPPORTED_FIRMWARE_TARGETS = [
  { target: 'esp32-4848s040', board: 'sunton_4848s040' },
  { target: 'waveshare-touch-lcd-4', board: 'waveshare_touch_lcd_4' },
  { target: 'waveshare-touch-lcd-4_3', board: 'waveshare_touch_lcd_4_3' },
  { target: 'waveshare-touch-lcd-4_3b', board: 'waveshare_touch_lcd_4_3b' },
  { target: 'waveshare-touch-lcd-5_800x480', board: 'waveshare_touch_lcd_5_800x480' },
  { target: 'waveshare-touch-lcd-5_1024x600', board: 'waveshare_touch_lcd_5_1024x600' },
  { target: 'waveshare-touch-lcd-7_800x480', board: 'waveshare_touch_lcd_7_800x480' },
  { target: 'waveshare-touch-lcd-7b_1024x600', board: 'waveshare_touch_lcd_7b_1024x600' }
]

// MGR-5: firmware artifact URLs (and the GitHub API base) are fetched
// server-side, so an unvalidated URL turns the manager into an open fetch proxy
// reachable toward LAN / cloud-metadata addresses if the SignalK admin session
// is off or compromised. Restrict ingest to https on a small host allowlist.
const FIRMWARE_URL_ALLOWED_HOSTS = [
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com'
]

// Validate an operator-supplied URL that the manager will later fetch(). Throws
// httpError(400, 'invalid_request') on a non-https scheme or a host not on the
// allowlist. `label` names the field for the error message.
function assertAllowedFirmwareUrl (rawUrl, label, allowedHosts) {
  const hosts = allowedHosts || FIRMWARE_URL_ALLOWED_HOSTS
  let parsed
  try {
    parsed = new URL(String(rawUrl))
  } catch (err) {
    throw httpError(400, 'invalid_request', `${label} is not a valid URL`)
  }
  if (parsed.protocol !== 'https:') {
    throw httpError(400, 'invalid_request', `${label} must use https (got ${parsed.protocol.replace(/:$/, '') || 'none'})`)
  }
  const host = parsed.hostname.toLowerCase()
  const ok = hosts.some((h) => host === h || host.endsWith(`.${h}`))
  if (!ok) {
    throw httpError(400, 'invalid_request', `${label} host "${host}" is not allowed (allowed: ${hosts.join(', ')})`)
  }
  return parsed
}

// PR #28 review: a re-registration may add or update capabilities, never
// remove one or turn a true flag off.
function mergeCapabilities (existing, incoming) {
  const out = { ...((existing && typeof existing === 'object') ? existing : {}) }
  if (!incoming || typeof incoming !== 'object') return out
  for (const [k, v] of Object.entries(incoming)) {
    if (out[k] === true && v !== true) continue
    if (v === undefined || v === null) continue
    out[k] = v
  }
  return out
}

class YeyBoatsDisplayManager {
  constructor (app, options) {
    this.app = app
    this.options = normalizeOptions(options || {})
    this.store = new JsonStore(app.getDataDirPath())
    this.store.init()
    // instruments-manager#19: per-device web API passwords (0600 file).
    this.secrets = new DeviceSecretStore(app.getDataDirPath()).load()
    // instruments-manager#23: this install's own manager API token (0600).
    this.apiToken = new ManagerApiTokenStore(app.getDataDirPath()).load()
    this._webAuthVerify = new Map()
    this._tokenPushes = new Map()
    // #25: one-time pairing codes for pending Re-claims (memory only).
    this._pairingCodes = new Map()
    // #25: rate limits for unauthenticated sightings and failed sign-ins.
    this._sightingLimits = { window: 0, first: 0, repeat: 0, byAddress: new Map() }
    this._loginFailures = { window: 0, count: 0, suppressed: 0 }
    // PR #28 review: suppressed failed sign-ins are summarised on a timer.
    this._loginSummaryTimer = setInterval(() => {
      try { this.flushLoginFailureSummary() } catch (e) {}
    }, SIGHTING_WINDOW_MS)
    if (this._loginSummaryTimer.unref) this._loginSummaryTimer.unref()
    this.markLegacyDeviceTokens()
    this.discoverySocket = null
    this.deviceDiscoverySocket = null
    this.mdnsDiscoverySocket = null
    this.mdnsAdvertiseTimer = null
    // Control-protocol client: the registry/naming layer now *speaks the
    // protocol*. It attaches to targets as a controller (carrying this
    // plugin's controllerId/name/color and optional shared key) to discover
    // DeviceRecords and to drive on-demand screen switches (attach->switch->
    // detach). Version negotiation, auth, and message validation are all the
    // shared @yeyboats/proto lib — never re-implemented here.
    this.protoControl = new ProtoControl({
      controllerId: this.options.control.controllerId,
      name: this.options.control.name,
      color: this.options.control.color,
      key: this.options.control.key,
      debug: this.app && this.app.debug ? (msg) => this.app.debug(msg) : undefined
    })
    this.startSignalKDiscovery()
    this.startDeviceDiscovery()
    this.startMdnsDiscovery()
    if (this.options.firmware.github.enabled) {
      this.refreshFirmwareFromGithub().catch((err) => {
        if (this.app && this.app.debug) {
          this.app.debug(`yey-display GitHub firmware refresh failed: ${err.message}`)
        }
      })
      this.refreshTipFromArtifacts().catch((err) => {
        if (this.app && this.app.debug) {
          this.app.debug(`yey-display TIP artifacts refresh failed: ${err.message}`)
        }
      })
    }
  }

  close () {
    if (this._loginSummaryTimer) {
      clearInterval(this._loginSummaryTimer)
      this._loginSummaryTimer = null
    }
    try { this.flushLoginFailureSummary() } catch (e) {}
    if (this.discoverySocket) {
      this.discoverySocket.close()
      this.discoverySocket = null
    }
    if (this.deviceDiscoverySocket) {
      this.deviceDiscoverySocket.close()
      this.deviceDiscoverySocket = null
    }
    if (this.mdnsDiscoverySocket) {
      this.mdnsDiscoverySocket.close()
      this.mdnsDiscoverySocket = null
    }
    if (this.mdnsAdvertiseTimer) {
      clearInterval(this.mdnsAdvertiseTimer)
      this.mdnsAdvertiseTimer = null
    }
  }

  startSignalKDiscovery () {
    const cfg = this.options.discoveryUdp
    if (!cfg.enabled) return

    const socket = dgram.createSocket('udp4')
    socket.on('error', (err) => {
      if (this.app && this.app.debug) {
        this.app.debug(`yey-display SignalK discovery UDP error: ${err.message}`)
      }
    })
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8').trim()
      if (text !== SIGNALK_DISCOVERY_QUERY) return

      const host = cfg.host || this.options.signalk.host || 'auto'
      const reply = Buffer.from(JSON.stringify({
        protocol: SIGNALK_DISCOVERY_PROTOCOL,
        serverId: this.options.serverId,
        host,
        port: this.options.signalk.port,
        http: {
          path: '/signalk',
          stream: '/signalk/v1/stream?subscribe=none'
        },
        manager: {
          basePath: '/plugins/yey-boats-display-manager'
        }
      }))
      socket.send(reply, rinfo.port, rinfo.address)
    })
    socket.bind(cfg.port, cfg.bind, () => {
      socket.setBroadcast(true)
      if (this.app && this.app.debug) {
        this.app.debug(`yey-display SignalK discovery UDP listening on ${cfg.bind}:${cfg.port}`)
      }
    })
    this.discoverySocket = socket
  }

  startDeviceDiscovery () {
    const cfg = this.options.deviceDiscoveryUdp
    if (!cfg.enabled) return

    const socket = dgram.createSocket('udp4')
    socket.on('error', (err) => {
      if (this.app && this.app.debug) {
        this.app.debug(`yey-display device discovery UDP error: ${err.message}`)
      }
    })
    socket.on('message', (msg, rinfo) => {
      let body
      try {
        body = JSON.parse(msg.toString('utf8'))
      } catch (err) {
        return
      }
      if (!body || body.protocol !== DEVICE_ANNOUNCE_PROTOCOL) return
      try {
        this.recordDiscoveredDevice({
          ...body,
          address: body.address || rinfo.address,
          transport: 'http',
          services: [
            { type: '_yeyboats._tcp', port: Number(body.port || 80) }
          ]
        })
      } catch (err) {
        if (this.app && this.app.debug) {
          this.app.debug(`yey-display device discovery ignored packet: ${err.message}`)
        }
      }
    })
    socket.bind(cfg.port, cfg.bind, () => {
      socket.setBroadcast(true)
      if (this.app && this.app.debug) {
        this.app.debug(`yey-display device discovery UDP listening on ${cfg.bind}:${cfg.port}`)
      }
    })
    this.deviceDiscoverySocket = socket
  }

  startMdnsDiscovery () {
    const cfg = this.options.network.mdns
    if (!cfg.enabled || (!cfg.browser && !cfg.advertiseManager)) return

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('error', (err) => {
      if (this.app && this.app.debug) {
        this.app.debug(`yey-display mDNS discovery error: ${err.message}`)
      }
    })
    socket.on('message', (msg, rinfo) => {
      if (cfg.browser) {
        for (const device of devicesFromMdnsPacket(msg, rinfo)) {
          try {
            this.recordDiscoveredDevice(device)
          } catch (err) {
            if (this.app && this.app.debug) {
              this.app.debug(`yey-display mDNS discovery ignored packet: ${err.message}`)
            }
          }
        }
      }
      if (cfg.advertiseManager && mdnsPacketHasQuestion(msg, YEYBOATS_MGMT_MDNS_SERVICE)) {
        this.sendManagerMdnsAdvertisement('query')
      }
    })
    socket.bind(cfg.port, cfg.bind, () => {
      try {
        socket.addMembership(MDNS_MULTICAST)
      } catch (err) {
        if (this.app && this.app.debug) {
          this.app.debug(`yey-display mDNS discovery multicast join failed: ${err.message}`)
        }
      }
      if (this.app && this.app.debug) {
        this.app.debug(`yey-display mDNS discovery listening on ${cfg.bind}:${cfg.port}`)
      }
      if (cfg.advertiseManager) {
        this.sendManagerMdnsAdvertisement('boot')
        this.mdnsAdvertiseTimer = setInterval(() => {
          this.sendManagerMdnsAdvertisement('periodic')
        }, cfg.advertiseIntervalMs)
      }
    })
    this.mdnsDiscoverySocket = socket
  }

  sendManagerMdnsAdvertisement (reason) {
    if (!this.mdnsDiscoverySocket) return
    const cfg = this.options.network.mdns
    const packet = buildManagerMdnsPacket(this.options, cfg)
    this.mdnsDiscoverySocket.send(packet, 0, packet.length, MDNS_PORT, MDNS_MULTICAST, (err) => {
      if (err && this.app && this.app.debug) {
        this.app.debug(`yey-display mDNS manager advertise ${reason} failed: ${err.message}`)
      } else if (this.app && this.app.debug) {
        this.app.debug(`yey-display mDNS manager advertise ${reason}`)
      }
    })
  }

  discovery () {
    return {
      protocol: PROTOCOL,
      serverId: this.options.serverId,
      basePath: '/plugins/yey-boats-display-manager',
      auth: {
        methods: this.options.auth.mode === 'dev-shared-token'
          ? ['bearer-device-token', 'dev-shared-token']
          : ['bearer-device-token', 'manager-api-token', 'provision-token']
      },
      intervals: {
        heartbeatMs: this.options.heartbeatMs,
        commandPollMs: this.options.commandPollMs
      },
      features: {
        registry: true,
        discovery: true,
        config: true,
        commands: true,
        firmware: true,
        ota: true,
        networkIdentity: true
      }
    }
  }

  getSettings () { return this.store.settings }

  getSettingsMasked () {
    const s = this.store.settings
    return {
      network: { ssid: s.network.ssid || '', mdnsDomain: s.network.mdnsDomain || 'yey.boats', password: '', passwordSet: Boolean(s.network.password) },
      ota: { password: '', passwordSet: Boolean(s.ota.password) },
      numbering: { ...s.numbering }
    }
  }

  updateSettings (patch) {
    const s = this.store.settings
    if (patch.network) {
      if (typeof patch.network.ssid === 'string') s.network.ssid = patch.network.ssid
      if (typeof patch.network.mdnsDomain === 'string') s.network.mdnsDomain = patch.network.mdnsDomain
      if (patch.network.password) s.network.password = patch.network.password
    }
    if (patch.ota && patch.ota.password) s.ota.password = patch.ota.password
    if (patch.numbering) {
      if (typeof patch.numbering.prefix === 'string') s.numbering.prefix = patch.numbering.prefix
      if (Number.isInteger(patch.numbering.pad)) s.numbering.pad = patch.numbering.pad
      if (Number.isInteger(patch.numbering.next)) s.numbering.next = patch.numbering.next
    }
    this.store.saveSettings()
    this.store.audit('settings.updated', 'system')
    return this.getSettingsMasked()
  }

  allocateDeviceNumber () {
    if (!this.store.settings.numbering) this.store.settings.numbering = { prefix: 'yey-d-', next: 1, pad: 3 }
    const n = this.store.settings.numbering
    const num = n.next; n.next = num + 1; this.store.saveSettings()
    return `${n.prefix}${String(num).padStart(n.pad || 0, '0')}`
  }

  registerDevice (body, auth) {
    const incoming = body.device || body
    const id = sanitizeDeviceId(incoming.id || incoming.deviceId)
    if (!id) throw httpError(400, 'invalid_request', 'device.id is required')
    const principal = this.registrationPrincipal(id, auth)

    const existing = this.store.registry.devices[id] || {}
    const created = !existing.id
    // #23: the shared dev token a not-yet-migrated device still holds proves
    // nothing about who is calling: keep the device alive, change nothing.
    if (principal.kind === 'legacy-device') {
      existing.lastSeen = now()
      this.store.saveRegistry()
      return this.registrationResponse(existing, false, null)
    }
    const merged = {
      ...existing,
      id,
      name: existing.name || incoming.name || id,
      claimed: existing.claimed || false,
      role: existing.role || incoming.role || 'display',
      location: existing.location || incoming.location || null,
      firstSeen: existing.firstSeen || now(),
      lastSeen: now(),
      identity: incoming,
      capabilities: mergeCapabilities(existing.capabilities, incoming.capabilities),
      display: incoming.display || existing.display || null,
      touch: incoming.touch || existing.touch || null,
      firmware: incoming.firmware || existing.firmware || null,
      board: incoming.board || incoming.board_id || existing.board || null,
      mac: incoming.mac || existing.mac || null,
      assignedProfile: existing.assignedProfile || null,
      overrides: existing.overrides || {},
      networkIdentity: this.resolveNetworkIdentity(existing, incoming),
      status: existing.status || {}
    }
    // PR #28 review: once advertised, the pairing-code gate is sticky (a
    // re-registration on a stolen token must not switch it off).
    if (existing.pairingCodeRequired || this.deviceSupportsPairingCode(merged)) {
      merged.pairingCodeRequired = true
      merged.capabilities.pairingCode = true
    }
    if (!merged.assignedProfile) {
      merged.assignedProfile = this.matchProfileForDevice(merged) || 'default'
    }

    if (created && !existing.assignedNumber && (!incoming.name || incoming.name === id)) {
      merged.assignedNumber = this.allocateDeviceNumber()
      merged.name = merged.assignedNumber
    } else if (existing.assignedNumber) {
      merged.assignedNumber = existing.assignedNumber
    }

    let issuedToken = null
    if (this.isDevAuthMode()) {
      if (!deviceHasToken(merged) && this.options.auth.mode === 'dev-shared-token') {
        issuedToken = this.options.auth.devToken
        merged.deviceTokenHash = hashToken(issuedToken)
        merged.deviceTokenId = 'dev'
        delete merged.deviceToken
      } else if (!deviceHasToken(merged)) {
        issuedToken = generateDeviceToken()
        merged.deviceTokenHash = hashToken(issuedToken)
        merged.deviceTokenId = randomId('tok')
        delete merged.deviceToken
      } else if (merged.deviceToken) {
        merged.deviceTokenHash = hashToken(merged.deviceToken)
        delete merged.deviceToken
      }
      if (!created) issuedToken = null
    } else if (created) {
      // A new device paired with an operator/provisioning credential.
      issuedToken = generateDeviceToken()
      this.setDeviceToken(merged, issuedToken)
    } else if (principal.kind === 'device' && merged.pendingTokenHash &&
        (!merged.reclaim || merged.reclaim.state === 'pending')) {
      // An operator Re-claim is pending and the display just proved itself
      // with its current token: hand it the new one. The current token keeps
      // working until the new one is used (verifyDeviceToken promotes it).
      // #25: handed out ONCE. Whoever holds the current token (possibly a
      // thief) cannot collect it again; the operator sees "issued" and can
      // cancel the Re-claim, or Revoke + confirm the address.
      issuedToken = this.secrets.pendingManagerToken(id)
      if (issuedToken && hashToken(issuedToken) === merged.pendingTokenHash) {
        merged.reclaim = { ...(merged.reclaim || {}), state: 'issued', issuedAt: now() }
      } else {
        issuedToken = null
        delete merged.pendingTokenHash
        merged.reclaim = { ...(merged.reclaim || {}), state: 'failed', lastError: 'pending token lost' }
      }
    } else if (merged.deviceToken) {
      merged.deviceTokenHash = hashToken(merged.deviceToken)
      delete merged.deviceToken
    }

    const firmwareChanged = this.noteFirmwareVersion(merged, existing)
    this.store.registry.devices[id] = merged
    this.store.saveRegistry()
    this.store.audit(created ? 'device.registered' : 'device.reregistered', id, { via: principal.kind })
    if (created) this.issuePairingWebSecret(id)
    if (firmwareChanged) {
      this.repushConfigAfterFirmwareChange(id, firmwareChanged)
      this.store.saveRegistry()
    }

    return this.registrationResponse(merged, created, issuedToken)
  }

  registrationResponse (device, created, issuedToken) {
    const id = device.id
    return {
      status: created ? 'registered' : 'updated',
      deviceId: id,
      claimed: device.claimed,
      assignedProfile: device.assignedProfile,
      deviceToken: issuedToken || undefined,
      tokenId: device.deviceTokenId,
      config: {
        version: this.configVersion(device),
        hash: this.generateConfig(id).hash,
        url: `/plugins/yey-boats-display-manager/devices/${id}/config`
      },
      commands: {
        url: `/plugins/yey-boats-display-manager/devices/${id}/commands`,
        pollMs: this.options.commandPollMs
      },
      heartbeat: {
        url: `/plugins/yey-boats-display-manager/devices/${id}/status`,
        intervalMs: this.options.heartbeatMs
      }
    }
  }

  listDevices () {
    const filter = arguments[0] || {}
    const nowMs = Date.now()
    const onlineWindowMs = Math.max(this.options.heartbeatMs * 3, 15000)
    const values = Object.values(this.store.registry.devices)
      .map((device) => {
        const summary = summarizeDevice(device)
        const lastSeenMs = summary.lastSeen ? Date.parse(summary.lastSeen) : 0
        summary.online = lastSeenMs > 0 && nowMs - lastSeenMs <= onlineWindowMs
        summary.pendingCommands = this.pendingCommands(summary.id).length
        summary.health = this.deviceHealth(device, summary.online, summary.pendingCommands)
        return summary
      })
      .filter((device) => {
        if (filter.health && device.health !== filter.health) return false
        if (filter.profile && device.assignedProfile !== filter.profile && device.profile !== filter.profile) return false
        if (filter.role && device.role !== filter.role) return false
        if (filter.location && device.location !== filter.location) return false
        return true
      })
    return {
      devices: values.sort((a, b) => a.id.localeCompare(b.id))
    }
  }

  // Lightweight summary list for remote enumeration (the Waveshare knob's
  // Select-Display menu). Each entry is the minimum the knob needs to render
  // a row and target a screen.set: id, label, role, online flag and the
  // device's current on-screen view. Distinct from listDevices() (which
  // returns the full management projection) so the firmware fetch stays small.
  deviceSummaries () {
    const nowMs = Date.now()
    const onlineWindowMs = Math.max(this.options.heartbeatMs * 3, 15000)
    const devices = Object.values(this.store.registry.devices)
      .map((device) => {
        const lastSeenMs = device.lastSeen ? Date.parse(device.lastSeen) : 0
        const online = lastSeenMs > 0 && nowMs - lastSeenMs <= onlineWindowMs
        return {
          id: device.id,
          name: device.name || device.id,
          role: device.role || 'display',
          online,
          currentScreen: (device.status && device.status.ui && device.status.ui.screen) || null
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
    return { devices }
  }

  // The set of views (screens) a device can switch between, for the knob's
  // Select-View menu. Derived from the device's generated layout screen list;
  // each view is { id, title }. `current` is the device's active screen id (if
  // reported via heartbeat). When the device has no stored/resolved screen
  // list, fall back to the standard known view ids so the menu is still usable.
  deviceViews (id) {
    const device = this.getDevice(id)
    let views = []
    // 1. Prefer the device's self-reported screen list (heartbeat ui.screens).
    // The firmware's actually-loaded layout can diverge from the manager's
    // generated config, so the device's own list is authoritative when present
    // — this is what makes switch-to-screen land on a real screen id.
    const reported = device.status && device.status.ui && device.status.ui.screens
    if (Array.isArray(reported) && reported.length > 0) {
      views = reported
        .filter((screen) => screen && screen.id)
        .map((screen) => ({ id: String(screen.id), title: String(screen.title || screen.id) }))
    }
    // 2. Fall back to the manager-generated config's screens.
    if (views.length === 0) {
      try {
        const config = this.generateConfig(id)
        const screens = (config.layout && Array.isArray(config.layout.screens))
          ? config.layout.screens
          : []
        views = screens
          .filter((screen) => screen && screen.id)
          .map((screen) => ({ id: String(screen.id), title: String(screen.title || screen.id) }))
      } catch (err) {
        views = []
      }
    }
    // 3. Last resort: the standard known view ids (so the menu is never empty).
    if (views.length === 0) {
      views = KNOWN_VIEW_IDS.map((id) => ({ id, title: KNOWN_VIEW_TITLES[id] || id }))
    }
    const current = (device.status && device.status.ui && device.status.ui.screen) || null
    return { views, current }
  }

  // The device's self-reported capability manifest (heartbeat ui.capabilities):
  // per-view-type limits/attrs the layout editor gates to. Returns null when the
  // device hasn't reported one yet (offline, or pre-manifest firmware).
  deviceCapabilities (id) {
    const device = this.getDevice(id)
    const caps = device.status && device.status.ui && device.status.ui.capabilities
    return caps && typeof caps === 'object' ? caps : null
  }

  // The manifest the layout editor gates to: the device's reported
  // `ui.capabilities`, or the built-in default set when the device is offline /
  // running pre-manifest firmware, so the editor still works.
  effectiveManifest (id) {
    return fieldSchema.resolveManifest(this.deviceCapabilities(id))
  }

  // ---- Slice 5: manifest-gated layout editor CRUD ------------------------
  //
  // The editor authors a device's screens (views) + per-field bindings into the
  // assigned profile's config: `layout.screens[*].tiles[*]` reference a key in
  // `widgets.items`, and each item holds the typed-tuple field (type, paths,
  // format, size, unit, color, range, zones, zoom). These methods are the
  // single write path; index.js routes call them. Every write is gated to the
  // device manifest (view/tile counts, field validity) and persisted, then a
  // config.reload is queued (poll + configPush) so the device fetches it.

  // The profile the editor mutates for a device (its assigned profile, default).
  editorProfile (id) {
    const device = this.getDevice(id)
    const profileId = device.assignedProfile || 'default'
    const profile = this.store.profiles.profiles[profileId]
    if (!profile) throw httpError(404, 'profile_not_found', `profile ${profileId} not found`)
    return profile
  }

  // The editable layout for a device: { manifest, screens:[{id,title,tiles}],
  // items } drawn from the assigned profile's raw config (NOT the resolved one —
  // the editor authors source, generateConfig resolves it for the device).
  editorLayout (id) {
    const profile = this.editorProfile(id)
    const cfg = profile.config || {}
    const screens = (cfg.layout && Array.isArray(cfg.layout.screens)) ? clone(cfg.layout.screens) : []
    const items = (cfg.widgets && cfg.widgets.items) ? clone(cfg.widgets.items) : {}
    return {
      profileId: profile.id,
      // The field editor reads its per-screen budget from here.
      manifest: Object.assign({}, this.effectiveManifest(id), { maxTilesPerScreen: this.editorMaxTiles(id) }),
      screens,
      items
    }
  }

  // Tiles per screen the editor may author for a device: the MIDL display
  // class's maxTiles (square-480: 9, the landscape classes: 6), the same cap
  // the MIDL validator and the device's MIDL render path use (#41). The
  // `maxTilesPerScreen` current firmware reports in ui.capabilities is the
  // legacy layout.h bound (4) and is not used for this.
  editorMaxTiles (id) {
    const display = this.resolveDisplay(this.getDevice(id))
    return midlLib.classForDisplay(display).maxTiles
  }

  // ---- validator on push ------------------------------------------------
  //
  // Before a layout is pushed to a display, the dashboard the display would
  // be sent (its profile, or `profileConfig`/`profileId`, merged with its
  // overrides and resolved for its display) is translated to MIDL and run
  // through midl's validator for the display's class: the checks the device
  // itself runs (instruments#37). A config with no screens is not checked
  // (the display shows its built-in dashboard). Without the validator built
  // into this install the push proceeds, flagged `unavailable` (the npm
  // package and the board image do not ship the midl submodule).
  checkDeviceLayout (id, opts) {
    opts = opts || {}
    const device = this.getDevice(id)
    const display = this.resolveDisplay(device)
    const className = midlLib.classForDisplay(display).id
    let base = opts.profileConfig
    if (base === undefined) {
      const profile = this.store.profiles.profiles[opts.profileId || device.assignedProfile || 'default'] ||
        this.store.profiles.profiles.default
      base = (profile && profile.config) || {}
    }
    const overrides = opts.overrides !== undefined ? opts.overrides : device.overrides
    const body = mergeDeep(base || {}, overrides || {})
    const structural = midlLib.v2LayoutIssues(body)
    if (structural.length) return { ok: false, className, issues: structural }
    const widgets = this.resolveWidgets(body.widgets || {}, device, display)
    const layout = this.resolveLayout(body.layout || {}, device, display, widgets)
    if (!layout.screens.length) return { ok: true, className, issues: [], skipped: 'no screens' }
    const { doc, ...result } = midlLib.midlDocumentFor({ layout, widgets }, className)
    return result
  }

  // Throwing form: a layout the validator rejects is a 422 `layout_invalid`
  // naming the display, its class and every issue. With `before` (a check of
  // the config being replaced) only issues the change introduces count, so a
  // stored layout that is already invalid can still be edited towards valid.
  requireValidDeviceLayout (id, opts, before) {
    const r = this.checkDeviceLayout(id, opts)
    if (r.unavailable || r.ok) return r
    const old = new Set(((before && before.issues) || []).map((i) => `${i.path}\u0000${i.message}`))
    const issues = r.issues.filter((i) => !old.has(`${i.path}\u0000${i.message}`))
    if (!issues.length) return r
    throw httpError(422, 'layout_invalid',
      `the layout for display ${id} fails MIDL validation for ${r.className}: ` +
      issues.slice(0, 3).map((i) => `${i.path || '/'} ${i.message}`).join('; ') +
      (issues.length > 3 ? ` (and ${issues.length - 3} more)` : ''),
      { deviceId: id, className: r.className, issues })
  }

  // Mutate the assigned profile's config under a guarded transaction: clone,
  // apply `mutate(cfg, manifest)`, validate counts, persist, reload. `mutate`
  // throws httpError on a manifest violation. Returns the fresh editorLayout.
  mutateEditorLayout (id, mutate) {
    const profile = this.editorProfile(id)
    const manifest = this.effectiveManifest(id)
    const cfg = clone(profile.config || {})
    cfg.layout = cfg.layout || { version: 1, screens: [] }
    if (!Array.isArray(cfg.layout.screens)) cfg.layout.screens = []
    cfg.widgets = cfg.widgets || { version: 1, items: {} }
    if (!cfg.widgets.items || typeof cfg.widgets.items !== 'object') cfg.widgets.items = {}

    const itemsBefore = Object.keys(cfg.widgets.items).length
    mutate(cfg, manifest)

    // Enforce the manifest caps after the mutation (defence in depth).
    const maxViews = Number(manifest.maxViews || 8)
    if (cfg.layout.screens.length > maxViews) {
      throw httpError(409, 'max_views_exceeded', `max views reached (${maxViews})`)
    }
    const maxTiles = this.editorMaxTiles(id)
    for (const s of cfg.layout.screens) {
      if (Array.isArray(s.tiles) && s.tiles.length > maxTiles) {
        throw httpError(409, 'max_tiles_exceeded', `screen "${s.id}" exceeds ${maxTiles} tiles`)
      }
    }
    // Drop orphan widget items not referenced by any tile (keeps the config
    // tidy and bounds growth). Built-in/legacy items referenced by preset tiles
    // stay because their tiles stay.
    const referenced = new Set()
    for (const s of cfg.layout.screens) {
      for (const t of (s.tiles || [])) if (t && t.widget) referenced.add(t.widget)
    }
    for (const key of Object.keys(cfg.widgets.items)) {
      if (!referenced.has(key)) delete cfg.widgets.items[key]
    }
    // The firmware rejects a whole config with more widget items than its
    // MAX_WIDGETS (manager_config.h: 32). With 6-9 tiles per screen that is
    // now reachable well before maxViews (#41).
    // Only a write that grows the count past the limit is refused, so a
    // profile already over it (imported) can still be shrunk.
    const itemsAfter = Object.keys(cfg.widgets.items).length
    if (itemsAfter > MAX_DEVICE_WIDGETS && itemsAfter > itemsBefore) {
      throw httpError(409, 'max_widgets_exceeded', `a device dashboard holds at most ${MAX_DEVICE_WIDGETS} fields in total`)
    }

    // Validator on push: refuse a change that makes the display's layout
    // fail MIDL validation (issues already present before it do not count).
    this.requireValidDeviceLayout(id, { profileConfig: cfg }, this.checkDeviceLayout(id, { profileConfig: profile.config || {} }))

    profile.config = cfg
    this.upsertProfile({ id: profile.id, name: profile.name || profile.id, config: cfg })
    // Config saved; the reload nudge is best-effort but a failure must not be
    // silent (MGR-8) — a broken reload trigger otherwise fails with zero trace.
    try {
      this.queueConfigReload(id)
    } catch (e) {
      if (this.app && this.app.debug) {
        this.app.debug(`yey-display: queueConfigReload failed for ${id}: ${e && e.message}`)
      }
    }
    return this.editorLayout(id)
  }

  // Reject reserved/dangerous object keys so a crafted id can never write onto
  // Object.prototype via our config maps.
  static safeKey (key) {
    const k = String(key || '')
    return k && k !== '__proto__' && k !== 'prototype' && k !== 'constructor'
  }

  // Stable slug for a new screen/widget id derived from a label, deduped.
  static slugify (label, prefix, taken) {
    let base = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    if (!base) base = prefix
    let candidate = base
    let n = 2
    while (taken.has(candidate)) { candidate = `${base}-${n++}` }
    return candidate
  }

  addScreen (id, opts) {
    return this.mutateEditorLayout(id, (cfg, manifest) => {
      const maxViews = Number(manifest.maxViews || 8)
      if (cfg.layout.screens.length >= maxViews) {
        throw httpError(409, 'max_views_exceeded', `max views reached (${maxViews})`)
      }
      const taken = new Set(cfg.layout.screens.map((s) => s.id))
      const title = String((opts && opts.title) || 'New View').slice(0, 64)
      const screenId = YeyBoatsDisplayManager.slugify(title, 'view', taken)
      cfg.layout.screens.push({ id: screenId, type: 'grid', title, tiles: [] })
    })
  }

  renameScreen (id, screenId, title) {
    return this.mutateEditorLayout(id, (cfg) => {
      const s = cfg.layout.screens.find((x) => x.id === screenId)
      if (!s) throw httpError(404, 'screen_not_found', `screen ${screenId} not found`)
      s.title = String(title || s.title).slice(0, 64)
    })
  }

  reorderScreens (id, order) {
    return this.mutateEditorLayout(id, (cfg) => {
      if (!Array.isArray(order)) throw httpError(400, 'invalid_request', 'order must be an array of screen ids')
      const byId = new Map(cfg.layout.screens.map((s) => [s.id, s]))
      const next = []
      for (const sid of order) { if (byId.has(sid)) { next.push(byId.get(sid)); byId.delete(sid) } }
      // Append any screens not named in `order` (never silently drop one).
      for (const s of byId.values()) next.push(s)
      cfg.layout.screens = next
    })
  }

  deleteScreen (id, screenId) {
    return this.mutateEditorLayout(id, (cfg) => {
      const before = cfg.layout.screens.length
      cfg.layout.screens = cfg.layout.screens.filter((s) => s.id !== screenId)
      if (cfg.layout.screens.length === before) {
        throw httpError(404, 'screen_not_found', `screen ${screenId} not found`)
      }
    })
  }

  // Add a field (tile + its widget item) to a screen. `field` is the typed
  // tuple; it is coerced + validated against the manifest before persisting.
  addField (id, screenId, field) {
    return this.mutateEditorLayout(id, (cfg, manifest) => {
      const s = cfg.layout.screens.find((x) => x.id === screenId)
      if (!s) throw httpError(404, 'screen_not_found', `screen ${screenId} not found`)
      if (!Array.isArray(s.tiles)) s.tiles = []
      const maxTiles = this.editorMaxTiles(id)
      if (s.tiles.length >= maxTiles) {
        throw httpError(409, 'max_tiles_exceeded', `max tiles per screen reached (${maxTiles}) on "${screenId}"`)
      }
      const coerced = fieldSchema.coerceField(field || {}, manifest)
      const result = fieldSchema.validateField(coerced, manifest)
      if (!result.ok) {
        throw httpError(422, 'field_invalid', 'field failed manifest validation', { errors: result.errors })
      }
      const taken = new Set(Object.keys(cfg.widgets.items))
      const widgetId = YeyBoatsDisplayManager.slugify(`${screenId}-${coerced.type}`, 'field', taken)
      cfg.widgets.items[widgetId] = this._fieldToWidgetItem(coerced)
      s.tiles.push({ widget: widgetId, ...this._fieldToTile(coerced) })
    })
  }

  // Reconfigure an existing field in place (by its widget id on a screen).
  updateField (id, screenId, widgetId, field) {
    if (!YeyBoatsDisplayManager.safeKey(widgetId)) throw httpError(400, 'invalid_request', 'invalid field id')
    return this.mutateEditorLayout(id, (cfg, manifest) => {
      const s = cfg.layout.screens.find((x) => x.id === screenId)
      if (!s) throw httpError(404, 'screen_not_found', `screen ${screenId} not found`)
      const tile = (s.tiles || []).find((t) => t && t.widget === widgetId)
      if (!tile) throw httpError(404, 'field_not_found', `field ${widgetId} not on screen ${screenId}`)
      if (!Object.prototype.hasOwnProperty.call(cfg.widgets.items, widgetId)) {
        throw httpError(404, 'field_not_found', `widget item ${widgetId} not found`)
      }
      // The field editor has no marker UI and echoes the stored markers back.
      // An unchanged ring that was stored before #32 (or by an import) is
      // cleaned rather than making the whole field uneditable; new or edited
      // markers are still validated strictly.
      const stored = cfg.widgets.items[widgetId]
      if (field && stored && stored.markers != null &&
          JSON.stringify(field.markers) === JSON.stringify(stored.markers)) {
        field = Object.assign({}, field, { markers: fieldSchema.sanitizeMarkers(stored.markers, manifest) })
      }
      const coerced = fieldSchema.coerceField(field || {}, manifest)
      const result = fieldSchema.validateField(coerced, manifest)
      if (!result.ok) {
        throw httpError(422, 'field_invalid', 'field failed manifest validation', { errors: result.errors })
      }
      cfg.widgets.items[widgetId] = this._fieldToWidgetItem(coerced)
      Object.assign(tile, { widget: widgetId, ...this._fieldToTile(coerced) })
    })
  }

  removeField (id, screenId, widgetId) {
    return this.mutateEditorLayout(id, (cfg) => {
      const s = cfg.layout.screens.find((x) => x.id === screenId)
      if (!s) throw httpError(404, 'screen_not_found', `screen ${screenId} not found`)
      const before = (s.tiles || []).length
      s.tiles = (s.tiles || []).filter((t) => !(t && t.widget === widgetId))
      if (s.tiles.length === before) {
        throw httpError(404, 'field_not_found', `field ${widgetId} not on screen ${screenId}`)
      }
      // Orphan item cleanup happens in mutateEditorLayout.
    })
  }

  // Map a coerced field tuple to a `widgets.items[*]` entry. We keep the full
  // typed tuple plus a flattened `type`/`path` for back-compat with the
  // existing resolve/preview pipeline (live-preview flattens to {widget,path}).
  _fieldToWidgetItem (field) {
    const item = {
      type: field.type,
      paths: field.paths || {},
      // Flattened single path for legacy consumers (live-preview, resolveWidgets).
      path: (field.paths && field.paths.value) || ''
    }
    if (field.title != null) item.title = field.title
    if (field.format != null) item.format = field.format
    if (field.size != null) item.size = field.size
    if (field.unit != null) item.unit = field.unit
    if (field.color != null) item.color = field.color
    if (field.range != null) item.range = field.range
    if (field.zones != null) item.zones = field.zones
    if (field.zoomable != null) item.zoomable = field.zoomable
    if (field.zoom != null) item.zoom = field.zoom
    // Compass marker fields (validated by field-schema, #32).
    if (field.reference != null) item.reference = field.reference
    if (Array.isArray(field.markers)) item.markers = field.markers
    return item
  }

  // The tile half of an authored field (the part the layout/preview reads).
  // Does NOT set `widget` — the caller owns the widget-item key so the tile
  // points at `widgets.items[widgetId]`, not at the bare type.
  _fieldToTile (field) {
    const tile = {}
    if (field.title != null) tile.title = field.title
    if (field.paths && field.paths.value) tile.path = field.paths.value
    if (field.unit != null) tile.unit = field.unit
    return tile
  }

  // Persist configured range/zones onto a field's metadata ("save limits").
  // Pure config write; the optional SK meta write-back is handled in index.js
  // (it needs the SignalK PUT transport). Returns the fresh editorLayout.
  saveFieldLimits (id, screenId, widgetId, limits) {
    if (!YeyBoatsDisplayManager.safeKey(widgetId)) throw httpError(400, 'invalid_request', 'invalid field id')
    return this.mutateEditorLayout(id, (cfg, manifest) => {
      if (!Object.prototype.hasOwnProperty.call(cfg.widgets.items, widgetId)) {
        throw httpError(404, 'field_not_found', `field ${widgetId} not found`)
      }
      const item = cfg.widgets.items[widgetId]
      if (!fieldSchema.RANGED_TYPES.includes(item.type)) {
        throw httpError(409, 'limits_not_applicable', `${item.type} fields have no range/zones`)
      }
      if (limits && limits.range && typeof limits.range.min === 'number' && typeof limits.range.max === 'number') {
        item.range = { min: limits.range.min, max: limits.range.max }
      }
      if (limits && Array.isArray(limits.zones)) {
        item.zones = limits.zones
      }
      // Markers belong to compass-like fields only (this path is gauge/bar):
      // stale stored ones are dropped rather than failing the limits save.
      delete item.markers
      delete item.reference
      // Re-validate the whole field after applying limits.
      const field = Object.assign({}, item, { paths: item.paths || { value: item.path } })
      const result = fieldSchema.validateField(field, manifest)
      if (!result.ok) {
        throw httpError(422, 'field_invalid', 'limits failed manifest validation', { errors: result.errors })
      }
    })
  }

  listDiscoveredDevices () {
    const registered = this.store.registry.devices
    const addressOwners = {}
    const observedAt = now()
    for (const device of Object.values(this.store.discovery.devices || {})) {
      if (device.supersededBy) continue
      if (isStaleDiscovery(device, observedAt)) continue
      const key = discoveryAddressKey(device)
      if (!key) continue
      if (!addressOwners[key]) addressOwners[key] = []
      addressOwners[key].push(device.deviceId)
    }
    return {
      devices: Object.values(this.store.discovery.devices || {})
        .map((device) => {
          const ageMs = device.lastSeen
            ? Date.now() - Date.parse(device.lastSeen)
            : Number.POSITIVE_INFINITY
          const key = discoveryAddressKey(device)
          const superseded = Boolean(device.supersededBy)
          const duplicateIds = key && !superseded
            ? (addressOwners[key] || []).filter((id) => id !== device.deviceId)
            : []
          const conflict = duplicateIds.length > 0
            ? { type: 'address', deviceIds: duplicateIds }
            : null
          return {
            ...device,
            registered: Boolean(registered[device.deviceId]),
            ageMs,
            stale: !Number.isFinite(ageMs) || ageMs > 60000,
            conflict,
            duplicate: Boolean(conflict),
            superseded
          }
        })
        .sort((a, b) => {
          const aTime = Date.parse(a.lastSeen || 0)
          const bTime = Date.parse(b.lastSeen || 0)
          return bTime - aTime || a.deviceId.localeCompare(b.deviceId)
        })
    }
  }

  announceDiscoveredDevice (body, auth) {
    if (this.options.auth.mode === 'dev-shared-token') {
      const ok = auth && (
        auth.bearer === this.options.auth.devToken ||
        (this.options.auth.provisionToken && auth.provision === this.options.auth.provisionToken)
      )
      if (!ok) throw httpError(401, 'unauthorized', 'discovery announcement requires manager token')
    } else if (this.options.auth.mode !== 'disabled') {
      const ok = this.verifyOperatorCredential(auth) || this.verifyStaticProvisionToken(auth)
      if (!ok) throw httpError(401, 'unauthorized', 'discovery announcement requires manager token')
    }
    return this.recordDiscoveredDevice(body)
  }

  // #23: an unauthenticated /devices/register (e.g. stock firmware presenting
  // its compiled-in bootstrap token) is not a pairing, but it is a sighting:
  // list it in Discovery, at the TCP peer address, so the operator can claim
  // it. Never touches a registered device's records.
  noteRejectedRegistration (body, remoteAddress) {
    if (this.isDevAuthMode()) return null
    const incoming = (body && (body.device || body)) || {}
    const id = sanitizeDeviceId(incoming.id || incoming.deviceId)
    if (!id || this.store.registry.devices[id]) return null
    const address = normalizeRemoteAddress(remoteAddress)
    if (!address) return null
    const existing = (this.store.discovery.devices || {})[id]
    // Never rewrite a UDP/mDNS/announcement record from an anonymous call.
    if (existing && existing.source !== 'register-rejected') return null
    // #29: an anonymous call never changes an existing sighting's address or
    // capabilities. The same id from another address is another sighting of
    // that id; the operator picks one when claiming.
    const sightings = existing ? anonymousSightings(existing) : []
    const seen = sightings.find((s) => s.address === address)
    if (!this.allowAnonymousSighting(address, Date.now(), Boolean(seen))) return null
    const sighting = { ...incoming, id, deviceId: id, address, source: 'register-rejected', transport: 'http' }
    delete sighting.ip
    delete sighting.device
    try {
      if (!existing) {
        if (!this.evictAnonymousSightings(id, address)) return null
        const result = this.recordDiscoveredDevice(sighting)
        result.device.sightings = [sightingEntry(result.device, result.device)]
        this.store.saveDiscovery()
        return result
      }
      const observedAt = now()
      if (seen) {
        seen.lastSeen = observedAt
        seen.seenCount = Number(seen.seenCount || 0) + 1
      } else {
        // PR #30 review: never evict a sighting because more addresses
        // arrive (an attacker could push the real one out). At the cap the
        // new address is refused and the record flags it for the operator.
        if (sightings.length >= MAX_ADDRESSES_PER_SIGHTING) {
          existing.sightings = sightings
          existing.refusedAddresses = Number(existing.refusedAddresses || 0) + 1
          existing.lastRefusedAt = observedAt
          this.store.saveDiscovery()
          this.store.audit('device.sighting_refused', id, { address, reason: 'too_many_addresses' })
          return null
        }
        const n = normalizeDiscoveryBody(sighting)
        sightings.push(sightingEntry(n, { firstSeen: observedAt, lastSeen: observedAt, seenCount: 1 }))
      }
      existing.sightings = sightings
      existing.lastSeen = observedAt
      existing.seenCount = Number(existing.seenCount || 0) + 1
      this.store.saveDiscovery()
      this.store.audit('device.discovered', id, { address, port: seen ? seen.port : Number(sighting.port || 80) })
      return {
        status: 'discovered',
        device: existing,
        registered: false,
        registerUrl: `/plugins/yey-boats-display-manager/devices/register`
      }
    } catch (err) {
      return null
    }
  }

  // #25: anyone on the network can call /devices/register; each sighting is a
  // discovery-file write and an audit line. Per-address and overall limits per
  // minute; anything over is dropped (a real display re-registers anyway).
  allowAnonymousSighting (address, at = Date.now(), refresh = false) {
    // #29: an IPv6 host owns a whole /64; count it as one address.
    address = sightingBucket(address)
    const l = this._sightingLimits
    if (at - l.window >= SIGHTING_WINDOW_MS) {
      l.window = at
      l.first = 0
      l.repeat = 0
      l.byAddress.clear()
    }
    const a = l.byAddress.get(address) || { total: 0, newIds: 0 }
    if (a.total >= SIGHTINGS_PER_ADDRESS_PER_WINDOW) return false
    if (!refresh) {
      if (a.newIds >= NEW_IDS_PER_ADDRESS_PER_WINDOW) return false
      if (a.newIds === 0) {
        if (l.first >= FIRST_SIGHTINGS_PER_WINDOW) return false
        l.first++
      } else {
        if (l.repeat >= REPEAT_SIGHTINGS_PER_WINDOW) return false
        l.repeat++
      }
      a.newIds++
    }
    a.total++
    l.byAddress.set(address, a)
    return true
  }

  // #25 / PR #28 review: at most MAX_ANONYMOUS_SIGHTINGS unauthenticated
  // records, at most MAX_SIGHTINGS_PER_ADDRESS per address. Room is made from
  // the address holding the most records (its oldest goes), so an address's
  // newest record is never evicted for another address's sake; a stale
  // single record may go. Records of registered devices are never touched.
  // Returns false when there is no room (the sighting is dropped).
  evictAnonymousSightings (incomingId, address, at = Date.now()) {
    const devices = this.store.discovery.devices || {}
    if (devices[incomingId]) return true
    const anon = Object.values(devices).filter((d) =>
      d.source === 'register-rejected' && !this.store.registry.devices[d.deviceId])
    const byAddr = new Map()
    for (const d of anon) {
      const k = sightingBucket(d.address)
      if (!byAddr.has(k)) byAddr.set(k, [])
      byAddr.get(k).push(d)
    }
    const age = (d) => Date.parse(d.lastSeen || '') || 0
    for (const list of byAddr.values()) list.sort((x, y) => age(x) - age(y))
    const drop = (d) => {
      delete devices[d.deviceId]
      const list = byAddr.get(sightingBucket(d.address))
      list.splice(list.indexOf(d), 1)
      anon.splice(anon.indexOf(d), 1)
    }
    const own = byAddr.get(sightingBucket(address)) || []
    while (own.length >= MAX_SIGHTINGS_PER_ADDRESS) drop(own[0])
    while (anon.length >= MAX_ANONYMOUS_SIGHTINGS) {
      let biggest = null
      for (const list of byAddr.values()) {
        if (list.length > 1 && (!biggest || list.length > biggest.length)) biggest = list
      }
      if (biggest) { drop(biggest[0]); continue }
      const oldest = anon.slice().sort((x, y) => age(x) - age(y))[0]
      if (!oldest || at - age(oldest) < SIGHTING_STALE_MS) return false
      drop(oldest)
    }
    return true
  }

  // #25: failed UI sign-ins are audited at most LOGIN_FAILURE_AUDITS_PER_WINDOW
  // times a minute; the next line written carries how many were left out.
  // PR #28 review: the ones left out are written as a
  // manager.login.failed.summary line (count since the last summary) when the
  // window rolls over, by a timer, and on close.
  auditFailedLogin (at = Date.now()) {
    const f = this._loginFailures
    if (at - f.window >= SIGHTING_WINDOW_MS) {
      this.flushLoginFailureSummary(at)
      f.window = at
      f.count = 0
    }
    if (f.count >= LOGIN_FAILURE_AUDITS_PER_WINDOW) {
      f.suppressed++
      return false
    }
    f.count++
    this.store.audit('manager.login.failed', 'system')
    return true
  }

  flushLoginFailureSummary (at = Date.now()) {
    const f = this._loginFailures
    if (!f.suppressed) return false
    const data = { suppressed: f.suppressed, since: new Date(f.window).toISOString(), until: new Date(at).toISOString() }
    f.suppressed = 0
    this.store.audit('manager.login.failed.summary', 'system', data)
    return true
  }

  async scanForDevices (body) {
    body = body || {}
    const method = String(body.method || 'ip').toLowerCase()
    if (method === 'ble') {
      return {
        method,
        status: 'unsupported',
        message: 'BLE scanning is not available in this SignalK Node runtime',
        scanned: 0,
        found: 0,
        devices: []
      }
    }
    if (method !== 'ip') {
      throw httpError(400, 'invalid_request', 'scan method must be ip or ble')
    }

    const ports = parseScanPorts(body.ports || body.port || 80)
    const timeoutMs = Math.max(250, Math.min(Number(body.timeoutMs || 900), 5000))
    const concurrency = Math.max(1, Math.min(Number(body.concurrency || 24), 64))
    const candidates = scanCandidates(body.target || body.targets, this.store, 512)
    const results = []
    let scanned = 0

    await mapLimit(candidates, concurrency, async (host) => {
      for (const port of ports) {
        scanned++
        const device = await this.probeHttpDevice(host, port, timeoutMs)
        if (!device) continue
        const recorded = this.recordDiscoveredDevice(device)
        results.push(recorded.device)
        break
      }
    })

    return {
      method,
      status: 'ok',
      scanned,
      found: results.length,
      devices: results
    }
  }

  async probeHttpDevice (host, port, timeoutMs) {
    const base = `http://${host}:${port}`
    let state
    try {
      state = await withAuthRetry(this.deviceWebAuthCandidatesForHost(host),
        (auth) => httpGetJson(`${base}/api/state`, auth, timeoutMs))
    } catch (err) {
      return null
    }
    return discoveryDeviceFromState(state, host, port)
  }

  async registerDeviceFromSignalK (body) {
    body = body || {}
    const address = String(body.address || body.host || '').trim()
    const port = Number(body.port || 80)
    if (!address) throw httpError(400, 'invalid_request', 'device address is required')
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw httpError(400, 'invalid_request', 'device port is invalid')
    }

    const probed = await this.probeHttpDevice(address, port, Number(body.timeoutMs || 1200))
    const deviceId = sanitizeDeviceId(
      body.deviceId ||
      body.id ||
      (probed && (probed.deviceId || probed.id))
    )
    if (!deviceId) {
      throw httpError(400, 'invalid_request', 'device id is required when probe cannot read /api/state')
    }

    this.recordDiscoveredDevice({
      ...(probed || {}),
      id: deviceId,
      deviceId,
      name: body.name || (probed && probed.name) || deviceId,
      role: body.role || (probed && probed.role) || 'display',
      location: body.location || (probed && probed.location) || null,
      source: 'signalk-manual',
      address,
      port,
      transport: 'http',
      authRequired: Boolean(this.options.deviceWebAuth.enabled)
    })

    const claimed = this.claimDiscoveredDevice(deviceId, {
      name: body.name,
      role: body.role || 'display',
      location: body.location,
      profileId: body.profileId || body.profile || 'default',
      sendReload: Boolean(body.sendReload),
      issueToken: true
    })

    // #23: hand the device its per-device token first, so the registration
    // that manager-register triggers authenticates as that device.
    let tokenDelivery = null
    if (this.secrets.pendingManagerToken(deviceId)) {
      tokenDelivery = await this.pushDeviceManagerToken(deviceId)
    }

    let deviceCommand = null
    if (body.sendManagerRegister) {
      const managerUrl = String(body.managerUrl || '').trim()
      if (!managerUrl) {
        throw httpError(400, 'invalid_request', 'managerUrl is required when sending manager-register')
      }
      const device = this.store.registry.devices[deviceId]
      deviceCommand = await withAuthRetry(this.deviceWebAuthCandidates(device),
        (auth) => postDeviceCommand(address, port, `manager-register ${managerUrl}`, auth))
    }

    return {
      status: claimed.status,
      deviceId,
      claimed,
      tokenDelivery,
      deviceCommand
    }
  }

  recordDiscoveredDevice (body) {
    const incoming = normalizeDiscoveryBody(body)
    const id = sanitizeDeviceId(incoming.id || incoming.deviceId)
    if (!id) throw httpError(400, 'invalid_request', 'device.id is required')
    const existing = this.store.discovery.devices[id] || {}
    const address = incoming.address || incoming.ip || null
    const previousAddresses = Array.isArray(existing.previousAddresses)
      ? existing.previousAddresses.slice()
      : []
    if (existing.address && address && existing.address !== address &&
        !previousAddresses.includes(existing.address)) {
      previousAddresses.unshift(existing.address)
      previousAddresses.splice(5)
    }
    const observedAt = now()

    const record = {
      deviceId: id,
      name: incoming.name || id,
      role: incoming.role || 'display',
      location: incoming.location || null,
      firstSeen: existing.firstSeen || observedAt,
      lastSeen: observedAt,
      seenCount: Number(existing.seenCount || 0) + 1,
      source: incoming.source || incoming.discoverySource || 'announcement',
      address,
      previousAddresses,
      port: Number(incoming.port || 80),
      transport: incoming.transport || 'http',
      services: incoming.services || [],
      mdns: incoming.mdns || null,
      display: incoming.display || null,
      firmware: incoming.firmware || null,
      board: incoming.board || null,
      authRequired: Boolean(incoming.authRequired),
      auth: {
        required: Boolean(incoming.authRequired),
        mode: incoming.authRequired ? 'basic' : 'none'
      },
      capabilities: incoming.capabilities || {},
      replacedDeviceIds: Array.isArray(existing.replacedDeviceIds)
        ? existing.replacedDeviceIds.slice()
        : []
    }
    const replacedDeviceIds = this.supersedeStaleDiscoveryRecords(record, observedAt)
    for (const replacedId of replacedDeviceIds) {
      if (!record.replacedDeviceIds.includes(replacedId)) {
        record.replacedDeviceIds.push(replacedId)
      }
    }
    if (existing.supersededBy === id) {
      delete record.supersededBy
      delete record.supersededAt
    }
    this.store.discovery.devices[id] = record
    this.store.saveDiscovery()
    this.store.audit('device.discovered', id, { address: record.address, port: record.port })
    return {
      status: 'discovered',
      device: record,
      registered: Boolean(this.store.registry.devices[id]),
      registerUrl: `/plugins/yey-boats-display-manager/devices/register`
    }
  }

  supersedeStaleDiscoveryRecords (fresh, observedAt) {
    const key = discoveryAddressKey(fresh)
    if (!key) return []
    const replaced = []
    for (const [otherId, other] of Object.entries(this.store.discovery.devices || {})) {
      if (otherId === fresh.deviceId || other.supersededBy) continue
      if (discoveryAddressKey(other) !== key) continue
      if (!isStaleDiscovery(other, observedAt)) continue
      other.supersededBy = fresh.deviceId
      other.supersededAt = observedAt
      for (const priorId of other.replacedDeviceIds || []) {
        if (!replaced.includes(priorId)) replaced.push(priorId)
        const prior = this.store.discovery.devices[priorId]
        if (prior) {
          prior.supersededBy = fresh.deviceId
          prior.supersededAt = observedAt
        }
      }
      replaced.push(otherId)
    }
    return replaced
  }

  claimDiscoveredDevice (id, body) {
    body = body || {}
    const deviceId = sanitizeDeviceId(id)
    if (!deviceId) throw httpError(400, 'invalid_request', 'device id is required')
    let discovered = this.store.discovery.devices[deviceId]
    if (!discovered) throw httpError(404, 'device_not_found', 'discovered device not found')

    const existing = this.store.registry.devices[deviceId] || {}
    const created = !existing.id
    this.checkPairingProof(body)
    // #29 (interim, until instruments#33): an anonymous sighting is only a
    // claim of an id. Anyone can send it from any address, so the operator
    // picks which of the addresses seen for that id is the display; the
    // claim takes that sighting's details and the token goes only there.
    let chosen = null
    if (discovered.source === 'register-rejected' && created) {
      const sightings = anonymousSightings(discovered)
      const wanted = typeof body.address === 'string' ? body.address.trim() : ''
      if (!wanted) {
        throw httpError(409, 'address_choice_required',
          'choose which address seen for this display to claim', { sightings })
      }
      chosen = sightings.find((s) => s.address === wanted)
      if (!chosen) throw httpError(400, 'address_not_seen', 'that address was not seen for this display')
      discovered = { ...discovered, ...chosen, source: discovered.source }
    }
    // #23: a sighting is unauthenticated. Claiming it over a paired display
    // would move that display's address and push it a token: re-keying a
    // paired display is Re-claim (reclaimDevice), which needs proof.
    if (!created && !this.isDevAuthMode()) {
      throw httpError(409, 'reclaim_required',
        'this display is already paired; re-key it with Re-claim on its device page')
    }
    const identity = {
      ...(existing.identity || {}),
      id: deviceId,
      name: body.name || discovered.name || existing.name || deviceId,
      board: discovered.board || discovered.board_id || existing.board || null,
      display: discovered.display || existing.display || null,
      firmware: discovered.firmware || existing.firmware || null,
      capabilities: discovered.capabilities || existing.capabilities || {}
    }
    const claimed = {
      ...existing,
      id: deviceId,
      name: body.name || existing.name || discovered.name || deviceId,
      claimed: true,
      claim: {
        claimedAt: existing.claim && existing.claim.claimedAt
          ? existing.claim.claimedAt
          : now(),
        updatedAt: now(),
        source: 'discovery',
        profileId: body.profileId || existing.assignedProfile || null
      },
      role: body.role || existing.role || discovered.role || 'display',
      location: body.location || existing.location || discovered.location || null,
      firstSeen: existing.firstSeen || discovered.firstSeen || now(),
      lastSeen: existing.lastSeen || discovered.lastSeen || now(),
      identity,
      capabilities: discovered.capabilities || existing.capabilities || {},
      display: discovered.display || existing.display || null,
      firmware: discovered.firmware || existing.firmware || null,
      board: discovered.board || existing.board || null,
      discovery: {
        source: discovered.source || 'announcement',
        address: discovered.address || null,
        port: Number(discovered.port || 80),
        lastSeen: discovered.lastSeen || null,
        services: discovered.services || [],
        authRequired: Boolean(discovered.authRequired)
      },
      auth: {
        ...(existing.auth || {}),
        web: {
          ...(existing.auth && existing.auth.web ? existing.auth.web : {}),
          required: Boolean(discovered.authRequired),
          mode: discovered.authRequired ? 'basic' : 'none',
          username: this.options.deviceWebAuth.username,
          passwordSet: true
        },
        manager: {
          mode: this.options.auth.mode
        }
      },
      assignedProfile: body.profileId || existing.assignedProfile || null,
      overrides: existing.overrides || {},
      status: existing.status || {}
    }
    if (!claimed.assignedProfile) {
      claimed.assignedProfile = this.matchProfileForDevice(claimed) || 'default'
    }
    if (!this.store.profiles.profiles[claimed.assignedProfile]) {
      throw httpError(404, 'profile_not_found', 'profile not found')
    }
    let issuedToken = null
    if (!this.isDevAuthMode() && (created || body.issueToken || !deviceHasToken(claimed))) {
      // #23: a fresh per-device token. The device does not have it yet: keep
      // it (0600) for delivery over the device's authenticated web API
      // (pushDeviceManagerToken) until the device authenticates with it.
      issuedToken = generateDeviceToken()
      this.setDeviceToken(claimed, issuedToken)
      this.secrets.setPendingManagerToken(deviceId, issuedToken)
      claimed.tokenDelivery = { state: 'pending', since: now(), attempts: 0 }
      if (chosen) claimed.tokenDelivery.target = { host: chosen.address, port: Number(chosen.port || 80) }
    } else if (body.issueToken && !created) {
      issuedToken = this.options.auth.mode === 'dev-shared-token'
        ? this.options.auth.devToken
        : generateDeviceToken()
      claimed.deviceTokenHash = hashToken(issuedToken)
      claimed.deviceTokenId = this.options.auth.mode === 'dev-shared-token' ? 'dev' : randomId('tok')
      delete claimed.deviceToken
    } else if (!deviceHasToken(claimed) && this.options.auth.mode === 'dev-shared-token') {
      issuedToken = this.options.auth.devToken
      claimed.deviceTokenHash = hashToken(issuedToken)
      claimed.deviceTokenId = 'dev'
      delete claimed.deviceToken
    } else if (!deviceHasToken(claimed)) {
      issuedToken = generateDeviceToken()
      claimed.deviceTokenHash = hashToken(issuedToken)
      claimed.deviceTokenId = randomId('tok')
      delete claimed.deviceToken
    } else if (claimed.deviceToken) {
      claimed.deviceTokenHash = hashToken(claimed.deviceToken)
      delete claimed.deviceToken
    }
    claimed.networkIdentity = this.resolveNetworkIdentity(claimed, identity)
    claimed.claim.profileId = claimed.assignedProfile
    claimed.updatedAt = now()

    this.store.registry.devices[deviceId] = claimed
    this.store.saveRegistry()
    if (created) this.issuePairingWebSecret(deviceId)
    this.store.audit(created ? 'device.claimed' : 'device.reclaimed', deviceId, {
      profileId: claimed.assignedProfile
    })

    let command = null
    if (body.sendReload) command = this.queueConfigReload(deviceId)

    return {
      status: created ? 'claimed' : 'updated',
      deviceId,
      claimed: true,
      assignedProfile: claimed.assignedProfile,
      deviceToken: created || body.issueToken ? issuedToken : undefined,
      tokenId: claimed.deviceTokenId,
      config: {
        version: this.configVersion(claimed),
        hash: this.generateConfig(deviceId).hash,
        url: `/plugins/yey-boats-display-manager/devices/${deviceId}/config`
      },
      command
    }
  }

  listGroups () {
    const groups = new Map()
    const add = (id, deviceId) => {
      if (!id) return
      const key = String(id).toLowerCase()
      const group = groups.get(key) || { id: key, devices: [] }
      if (!group.devices.includes(deviceId)) group.devices.push(deviceId)
      groups.set(key, group)
    }
    Object.values(this.store.registry.devices).forEach((device) => {
      add('all', device.id)
      add(device.role, device.id)
      add(device.location, device.id)
    })
    return { groups: Array.from(groups.values()).sort((a, b) => a.id.localeCompare(b.id)) }
  }

  pluginCapabilities () {
    return {
      protocol: PROTOCOL,
      widgets: {
        types: [
          'numeric',
          'text',
          'gauge',
          'compass',
          'windRose',
          'trend',
          'bar',
          'button',
          'autopilot'
        ],
        optionalTypes: ['map']
      },
      fonts: {
        properties: [
          'fontSize',
          'labelFontSize',
          'valueFontSize',
          'unitFontSize',
          'titleFontSize',
          'buttonFontSize'
        ]
      },
      layout: {
        types: ['grid'],
        variantMatching: ['board', 'display.width', 'display.height', 'display.shape', 'capabilities']
      },
      limits: {
        maxWidgets: MAX_DEVICE_WIDGETS,
        maxScreens: 16,
        maxTilesPerScreen: 16,
        maxWidgetIdLength: 31,
        maxPathLength: 95,
        maxTitleLength: 23
      }
    }
  }

  dashboard () {
    this.expireCommands()
    const devices = Object.values(this.store.registry.devices)
    const nowMs = Date.now()
    const onlineWindowMs = Math.max(this.options.heartbeatMs * 3, 15000)
    const summaries = devices
      .map((device) => {
        const config = this.generateConfig(device.id)
        const lastSeenMs = device.lastSeen ? Date.parse(device.lastSeen) : 0
        const online = lastSeenMs > 0 && nowMs - lastSeenMs <= onlineWindowMs
        const pending = this.pendingCommands(device.id).length
        return {
          id: device.id,
          name: device.name,
          role: device.role,
          location: device.location,
          online,
          lastSeen: device.lastSeen || null,
          board: device.board || null,
          firmware: device.firmware || null,
          display: this.resolveDisplay(device),
          profile: device.assignedProfile || 'default',
          desiredConfig: {
            version: this.configVersion(device),
            hash: config.hash,
            layoutVariant: config.layout ? config.layout.variant : null,
            widgetVariant: config.widgets ? config.widgets.variant : null
          },
          reportedConfig: device.config || null,
          configDrift: !device.config || device.config.hash !== config.hash,
          networkIdentity: device.networkIdentity || null,
          pendingCommands: pending,
          health: this.deviceHealth(device, online, pending)
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))

    const commandCounts = this.store.commands.commands.reduce((acc, cmd) => {
      acc[cmd.status] = (acc[cmd.status] || 0) + 1
      return acc
    }, {})
    const jobCounts = this.store.jobs.jobs.reduce((acc, job) => {
      acc[job.status] = (acc[job.status] || 0) + 1
      return acc
    }, {})

    return {
      generatedAt: now(),
      protocol: PROTOCOL,
      serverId: this.options.serverId,
      managerApiToken: this.apiToken ? this.apiToken.status() : null,
      auth: {
        mode: this.options.auth.mode,
        requestedMode: this.options.auth.requestedMode,
        legacyTokenDevices: devices.filter((d) => d.legacyTokenHash).length,
        reclaimNeeded: devices.filter((d) => d.legacyTokenHash || !deviceHasToken(d)).length,
        signalkSecurity: this.signalkSecurityEnabled() ? 'on' : 'off',
        devAuth: this.isDevAuthMode()
      },
      counts: {
        devices: devices.length,
        online: summaries.filter((device) => device.online).length,
        offline: summaries.filter((device) => !device.online).length,
        configDrift: summaries.filter((device) => device.configDrift).length,
        pendingCommands: this.store.commands.commands.filter((cmd) => cmd.status === 'pending').length,
        profiles: Object.keys(this.store.profiles.profiles).length,
        firmwareArtifacts: this.store.firmware.artifacts.length,
        firmwareJobs: this.store.jobs.jobs.length
      },
      commandCounts,
      firmwareJobCounts: jobCounts,
      groups: this.listGroups().groups,
      devices: summaries,
      recentCommands: this.store.commands.commands.slice(-10).reverse(),
      recentFirmwareJobs: this.store.jobs.jobs.slice(-10).reverse()
    }
  }

  deviceHealth (device, online, pendingCommands) {
    if (!online) return 'offline'
    if (device.config && device.config.applied === false) return 'config-error'
    if (pendingCommands > 0) return 'pending'
    if (device.networkIdentity && device.networkIdentity.conflict) return 'network-conflict'
    return 'ok'
  }

  getDevice (id) {
    const device = this.store.registry.devices[id]
    if (!device) throw httpError(404, 'device_not_found', 'device not found')
    return device
  }

  patchDevice (id, patch) {
    const device = this.getDevice(id)
    const allowed = ['name', 'role', 'location', 'claimed', 'assignedProfile', 'overrides', 'networkIdentity']
    allowed.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(patch, key)) device[key] = patch[key]
    })
    device.networkIdentity = this.resolveNetworkIdentity(device, device.identity || {})
    device.updatedAt = now()
    this.store.saveRegistry()
    this.store.audit('device.updated', id, patch)
    return device
  }

  assignProfile (id, body) {
    const device = this.getDevice(id)
    const profileId = body.profileId || body.profile
    if (!profileId) throw httpError(400, 'invalid_request', 'profileId is required')
    if (!this.store.profiles.profiles[profileId]) {
      throw httpError(404, 'profile_not_found', 'profile not found')
    }
    // Validator on push: the display renders what it is assigned, so a
    // layout it would reject is refused before anything changes.
    const layoutValidation = this.requireValidDeviceLayout(id, {
      profileId, overrides: body.overrides || device.overrides
    })
    device.assignedProfile = profileId
    if (body.overrides) device.overrides = body.overrides
    device.updatedAt = now()
    this.store.saveRegistry()
    this.store.audit('device.profile.assigned', id, { profileId })
    const command = body.sendReload ? this.queueConfigReload(id) : null
    return {
      deviceId: id,
      assignedProfile: profileId,
      config: {
        version: this.configVersion(device),
        hash: this.generateConfig(id).hash
      },
      layoutValidation,
      command
    }
  }

  // Validator on push for several displays at once: every display is checked
  // before any is changed, so a batch either applies everywhere or nowhere.
  requireValidLayouts (deviceIds, optsFor) {
    const failed = []
    for (const deviceId of deviceIds) {
      try {
        this.requireValidDeviceLayout(deviceId, optsFor(deviceId))
      } catch (e) {
        if (!e || e.status !== 422 || !e.payload) throw e
        failed.push(e.payload.error.details)
      }
    }
    if (failed.length === 1) {
      const d = failed[0]
      throw httpError(422, 'layout_invalid', `the layout for display ${d.deviceId} fails MIDL validation for ${d.className}: ` +
        d.issues.slice(0, 3).map((i) => `${i.path || '/'} ${i.message}`).join('; '), d)
    }
    if (failed.length) {
      throw httpError(422, 'layout_invalid',
        `the layout fails MIDL validation on ${failed.length} displays: ${failed.map((d) => `${d.deviceId} (${d.className})`).join(', ')}`,
        { devices: failed })
    }
  }

  applyProfile (profileId, body) {
    body = body || {}
    if (!this.store.profiles.profiles[profileId]) {
      throw httpError(404, 'profile_not_found', 'profile not found')
    }
    const deviceIds = Array.isArray(body.deviceIds)
      ? body.deviceIds
      : (body.deviceIds ? [body.deviceIds] : [])
    if (deviceIds.length === 0) throw httpError(400, 'invalid_request', 'deviceIds is required')
    this.requireValidLayouts(deviceIds, (deviceId) => ({
      profileId, overrides: body.clearOverrides ? {} : this.getDevice(deviceId).overrides
    }))
    const results = deviceIds.map((deviceId) => {
      const device = this.getDevice(deviceId)
      return this.assignProfile(deviceId, {
        profileId,
        overrides: body.clearOverrides ? {} : device.overrides,
        sendReload: Boolean(body.sendReload)
      })
    })
    return {
      profileId,
      count: results.length,
      results
    }
  }

  updateStatus (id, body, auth) {
    const principal = this.requireDeviceAuth(id, auth)
    const device = this.getDevice(id)
    device.lastSeen = now()
    body = body || {}
    if (!principal.trusted) {
      // #23: a not-yet-migrated device on the shared dev token. Anyone could
      // be presenting that token, so it may keep the device alive but must
      // not move its address (the manager sends the device's credentials
      // there) or rewrite what it reports about its web auth.
      body = { ...body }
      delete body.network
      delete body.webAuth
      const previous = device.status && device.status.network
      if (previous) body.network = previous
    }
    const previousFirmware = { firmware: device.firmware, identity: device.identity,
      lastSeenFirmwareVersion: device.lastSeenFirmwareVersion }
    device.status = body
    if (body.firmware) device.firmware = body.firmware
    // PR #27 review: an untrusted principal (the shared yeyboats-dev token)
    // proves nothing and only ever gets the redacted config: no re-push.
    const firmwareChanged = principal.trusted ? this.noteFirmwareVersion(device, previousFirmware) : null
    if (body.display) device.display = body.display
    if (body.touch) device.touch = body.touch
    if (body.webAuth) device.webAuth = body.webAuth
    if (body.network && principal.trusted) {
      device.networkIdentity = {
        ...(device.networkIdentity || {}),
        currentHostname: body.network.hostname || null,
        currentDomain: body.network.domain || null,
        currentFqdn: body.network.fqdn || null,
        lastResolvedAddress: body.network.ip || null,
        mdnsEnabled: Boolean(body.network.mdns && body.network.mdns.enabled)
      }
    }
    if (body.config) {
      device.config = {
        version: body.config.version,
        hash: body.config.hash,
        applied: body.config.applied
      }
    }
    if (firmwareChanged) this.repushConfigAfterFirmwareChange(id, firmwareChanged)
    this.store.saveRegistry()
    const desiredHash = this.generateConfig(id).hash
    // #19: the device reports the config carrying its current web password as
    // applied; confirm the password works before retiring any fallback.
    const web = this.secrets.web(id)
    if (principal.trusted && web && web.state !== 'verified' && this.options.deviceWebAuth.enabled &&
        body.config && body.config.hash === desiredHash) {
      this.verifyDeviceWebPassword(id)
    }
    return {
      status: 'ok',
      serverTime: now(),
      desiredConfig: {
        version: this.configVersion(device),
        hash: desiredHash,
        reload: Boolean(firmwareChanged) || !device.config || device.config.hash !== desiredHash
      },
      // #23: a pending Re-claim: the display re-registers with its current
      // token and collects its new one.
      requestedReregister: Boolean(principal.kind === 'device' && device.pendingTokenHash &&
        (!device.reclaim || device.reclaim.state === 'pending')) || undefined,
      commandsPending: this.pendingCommands(id).length
    }
  }

  // #26: record the firmware version a display reports and say whether it
  // differs from the one last seen (upgrade or downgrade). `previous` is the
  // device record before this report; records from before #26 have no
  // lastSeenFirmwareVersion, so fall back to their stored firmware. A first
  // sighting (no previous version) is not a change.
  noteFirmwareVersion (device, previous) {
    const current = firmwareVersionFromDevice(device)
    if (!current) return null
    const before = (previous && previous.lastSeenFirmwareVersion) ||
      (previous ? firmwareVersionFromDevice(previous) : null)
    device.lastSeenFirmwareVersion = String(current)
    if (!before || String(before) === String(current)) return null
    return { from: String(before), to: String(current) }
  }

  // #26: after a firmware change the display may no longer hold a usable copy
  // of its config: an older build can't read the web password a newer one
  // stored hashed (instruments#34), and the reported config hash can still
  // match. Re-push the whole generated config (incl. the web password).
  // PR #27 review: flapping versions must not grow the command store or the
  // audit log. At most one re-push per FIRMWARE_REPUSH_INTERVAL_MS per
  // display; an already pending config.reload is refreshed, not duplicated;
  // changes inside the window are counted and audited once as flapping. (The
  // heartbeat response still flags reload: that costs nothing to store.)
  repushConfigAfterFirmwareChange (id, change, at = Date.now()) {
    const device = this.store.registry.devices[id]
    if (!device) return null
    const state = device.firmwareRepush || {}
    const last = Date.parse(state.lastAt || '') || 0
    if (last && at - last < FIRMWARE_REPUSH_INTERVAL_MS) {
      state.suppressed = Number(state.suppressed || 0) + 1
      if (!state.flappingAuditedAt || Date.parse(state.flappingAuditedAt) < last) {
        state.flappingAuditedAt = new Date(at).toISOString()
        this.store.audit('device.firmware.flapping', id, { from: change.from, to: change.to, since: state.lastAt })
      }
      device.firmwareRepush = state
      return null
    }
    const suppressed = Number(state.suppressed || 0)
    device.firmwareRepush = { lastAt: new Date(at).toISOString(), suppressed: 0 }
    this.store.audit('device.firmware.changed', id, {
      from: change.from, to: change.to, action: 'config.reload', ...(suppressed ? { suppressedChanges: suppressed } : {})
    })
    return this.queueConfigReload(id, { coalesce: true })
  }

  generateConfig (id) {
    const device = this.getDevice(id)
    const profile = this.store.profiles.profiles[device.assignedProfile || 'default'] ||
      this.store.profiles.profiles.default
    const body = mergeDeep(profile.config || {}, device.overrides || {})
    const networkIdentity = this.resolveNetworkIdentity(device, device.identity || {})
    const display = this.resolveDisplay(device)
    const widgets = this.resolveWidgets(body.widgets || {}, device, display)
    const layout = this.resolveLayout(body.layout || {}, device, display, widgets)
    const config = {
      protocol: PROTOCOL,
      deviceId: id,
      version: this.configVersion(device),
      profile: profile.id,
      generatedAt: now(),
      display: {
        ...display,
        selectedVariant: layout.variant || widgets.variant || null
      },
      management: {
        heartbeatMs: this.options.heartbeatMs,
        commandPollMs: this.options.commandPollMs
      },
      network: {
        hostname: networkIdentity.desiredHostname,
        domain: networkIdentity.desiredDomain,
        fqdn: networkIdentity.desiredFqdn,
        mdns: {
          enabled: this.options.network.mdns.enabled,
          services: [
            {
              type: '_yeyboats._tcp',
              port: 80,
              txt: {
                id,
                role: device.role || 'display',
                location: device.location || '',
                fw: device.firmware && device.firmware.version
                  ? device.firmware.version
                  : ''
              }
            },
            {
              type: '_arduino._tcp',
              port: 3232,
              txt: {
                id,
                ota: 'true'
              }
            }
          ]
        }
      },
      signalk: {
        host: this.options.signalk.host,
        port: this.options.signalk.port,
        useMdns: true
      },
      webAuth: {
        enabled: this.options.deviceWebAuth.enabled,
        username: this.options.deviceWebAuth.username,
        password: this.webSecret(id).password
      },
      ota: {
        enabled: true,
        mode: 'arduino-ota',
        address: networkIdentity.desiredFqdn,
        port: 3232,
        passwordSet: Boolean(device.secrets && device.secrets.otaPasswordSet)
      },
      ...body,
      layout,
      widgets
    }
    // #32: every `markers` array anywhere in the pushed config is checked.
    const markerManifest = this.effectiveManifest(id)
    for (const key of Object.keys(config)) {
      config[key] = fieldSchema.sanitizeMarkersDeep(config[key], markerManifest)
    }
    const otaSettings = this.store.settings && this.store.settings.ota
    if (otaSettings && otaSettings.password) {
      config.ota = Object.assign({}, config.ota, { password: otaSettings.password })
    }
    const hashBody = clone(config)
    delete hashBody.generatedAt
    config.hash = sha256Json(hashBody)
    return config
  }

  // ---- per-device web API password (instruments-manager#19) -------------
  //
  // Pairing issues each device its own random password; it reaches the device
  // in the pulled config (webAuth.password). A device paired before #19 has no
  // record: the first contact issues one with the old shared password as a
  // fallback, the config hash changes so the next heartbeat makes the device
  // pull it, and once the device reports that hash the manager verifies the
  // new password over HTTP and drops the fallback. Never log a password.
  webSecret (id) {
    let web = this.secrets.web(id)
    if (!web) {
      if (!this.store.registry.devices[id]) throw httpError(404, 'device_not_found', 'device not found')
      web = this.secrets.issueWeb(id, 'migrated', [this.options.deviceWebAuth.legacyPassword])
      this.store.audit('device.webAuth.migrating', id)
    }
    return web
  }

  issuePairingWebSecret (id) {
    if (this.secrets.web(id)) return
    this.secrets.issueWeb(id, 'paired', [])
    this.store.audit('device.webAuth.issued', id)
  }

  deviceWebAuth (device) {
    const id = device && (device.id || device.deviceId)
    const known = id && this.store.registry.devices[id]
    return {
      enabled: this.options.deviceWebAuth.enabled,
      username: this.options.deviceWebAuth.username,
      password: known ? this.webSecret(id).password : null
    }
  }

  // Credentials to try in order: the current password, then any the device
  // may still enforce (pre-migration / un-applied rotation). Only a 401 moves
  // on to the next one.
  deviceWebAuthCandidates (device) {
    const primary = this.deviceWebAuth(device)
    const out = [primary]
    const id = device && (device.id || device.deviceId)
    const web = id && this.secrets ? this.secrets.web(id) : null
    if (primary && primary.enabled && web) {
      for (const password of web.fallbacks || []) out.push({ ...primary, password })
    }
    return out
  }

  // Probe of an address that may not be a paired device yet: a known device's
  // own credentials, else none (setup-open), then the legacy shared password.
  deviceWebAuthCandidatesForHost (host) {
    const device = this.findDeviceByHost(host)
    if (device) return this.deviceWebAuthCandidates(device)
    const base = { enabled: this.options.deviceWebAuth.enabled, username: this.options.deviceWebAuth.username }
    return [{ ...base, password: null }, { ...base, password: this.options.deviceWebAuth.legacyPassword }]
  }

  // The registered device known at `host` (IP or hostname), or null.
  findDeviceByHost (host) {
    const want = String(host || '').toLowerCase().replace(/\.$/, '')
    if (!want) return null
    return Object.values(this.store.registry.devices).find((d) => {
      try {
        return this.deviceHttpCandidates(d)
          .some((u) => u.replace(/^http:\/\//, '').replace(/:\d+$/, '').toLowerCase() === want)
      } catch (e) { return false }
    }) || null
  }

  // Credentials for a proxied device request (#20). Only a host that is a
  // registered device gets that device's credentials; anything else gets
  // none, so the proxy never hands a password to an arbitrary LAN host.
  // #23 (#22 nit): and only on that device's own web API port, so another
  // service on the same IP never receives the device's password.
  deviceWebAuthCandidatesForProxy (host, port) {
    const device = this.findDeviceByHost(host)
    if (!device) return [null]
    const want = port === undefined || port === null || port === '' ? 80 : Number(port)
    if (want !== this.deviceHttpPort(device)) return [null]
    return this.deviceWebAuthCandidates(device)
  }

  webAuthStatus (id) {
    this.getDevice(id)
    const web = this.webSecret(id)
    return {
      deviceId: id,
      enabled: this.options.deviceWebAuth.enabled,
      username: this.options.deviceWebAuth.username,
      passwordSet: true,
      state: web.state,
      reason: web.reason || null,
      fallbacks: (web.fallbacks || []).length,
      createdAt: web.createdAt || null,
      rotatedAt: web.rotatedAt || null,
      verifiedAt: web.verifiedAt || null
    }
  }

  rotateDeviceWebPassword (id) {
    this.getDevice(id)
    this.webSecret(id)
    this.secrets.rotateWeb(id)
    this.store.audit('device.webAuth.rotated', id)
    const command = this.queueConfigReload(id)
    return { ...this.webAuthStatus(id), command }
  }

  // Confirm the device now accepts its current password (no fallbacks), then
  // retire the fallbacks. Resolves true/false; never rejects.
  verifyDeviceWebPassword (id) {
    const inflight = this._webAuthVerify.get(id)
    if (inflight && !inflight.done) return inflight.promise
    const entry = { done: false, promise: null }
    entry.promise = (async () => {
      try {
        const device = this.getDevice(id)
        const auth = this.deviceWebAuth(device)
        await this._fetchDeviceJsonWith(device, '/api/state', [auth])
        const ok = this.secrets.markWebVerified(id, auth.password)
        if (ok) this.store.audit('device.webAuth.verified', id)
        return ok
      } catch (err) {
        if (this.app && this.app.debug) {
          this.app.debug(`yey-display web password verify for ${id} failed: ${err.message}`)
        }
        return false
      } finally {
        entry.done = true
      }
    })()
    this._webAuthVerify.set(id, entry)
    return entry.promise
  }

  pendingWebAuthVerification (id) {
    const entry = this._webAuthVerify.get(id)
    return entry ? entry.promise : Promise.resolve(null)
  }

  // All addresses we know for a device, in preference order, deduped. A stale
  // cached IP (status.network.ip / lastResolvedAddress) can outlive its DHCP
  // lease; keeping the mDNS FQDN as a fallback lets fetchDeviceJson recover
  // when the IP no longer resolves to the device.
  deviceHttpCandidates (device) {
    const ni = (device && device.networkIdentity) || {}
    const raw = [
      device && device.status && device.status.network && device.status.network.ip,
      ni.lastResolvedAddress,
      ni.currentFqdn,
      ni.desiredFqdn
    ].filter(Boolean)
    const seen = new Set()
    const urls = []
    const port = this.deviceHttpPort(device)
    for (const addr of raw) {
      const url = `http://${addr}:${port}`
      if (!seen.has(url)) { seen.add(url); urls.push(url) }
    }
    if (urls.length === 0) {
      throw httpError(409, 'device_address_unknown', 'device address is unknown')
    }
    return urls
  }

  // The device's web API port: 80 unless discovery/registration said otherwise.
  deviceHttpPort (device) {
    const port = Number((device && device.httpPort) || (device && device.discovery && device.discovery.port) || 80)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 80
  }

  deviceHttpBase (device) {
    return this.deviceHttpCandidates(device)[0]
  }

  // Record an address that just worked so the next fetch tries it first.
  noteResolvedAddress (device, host) {
    if (!device || !host) return
    device.networkIdentity = device.networkIdentity || {}
    device.networkIdentity.lastResolvedAddress = host
    // Devices live in the registry store; saveRegistry() is the persist call
    // used throughout this class.
    if (this.store && typeof this.store.saveRegistry === 'function') {
      this.store.saveRegistry()
    }
  }

  getLiveStatus (id) {
    return this.fetchDeviceJson(this.getDevice(id), '/api/state')
  }

  getLiveLogs (id, since) {
    const query = since ? `?since=${encodeURIComponent(since)}` : ''
    return this.fetchDeviceJson(this.getDevice(id), `/api/logs${query}`)
  }

  // Indirection so tests can stub the transport; defaults to the module
  // httpGetJson. Returns a Promise<json>.
  _httpGetJson (url, auth) {
    return httpGetJson(url, auth)
  }

  async fetchDeviceJson (device, path) {
    return this._fetchDeviceJsonWith(device, path, this.deviceWebAuthCandidates(device))
  }

  async _fetchDeviceJsonWith (device, path, auths) {
    const candidates = this.deviceHttpCandidates(device)
    let lastErr
    for (let i = 0; i < candidates.length; i++) {
      const base = candidates[i]
      try {
        const json = await withAuthRetry(auths, (auth) => this._httpGetJson(`${base}${path}`, auth))
        if (i > 0) {
          const host = base.replace(/^http:\/\//, '').replace(/:\d+$/, '')
          this.noteResolvedAddress(device, host)
        }
        return json
      } catch (err) {
        lastErr = err
        if (this.app && this.app.debug) {
          this.app.debug(`yey-display device fetch ${base}${path} failed: ${err.message}`)
        }
      }
    }
    throw lastErr
  }

  listProfiles () {
    // Auto-seed the default profile's layout on first inspection if
    // the operator hasn't touched it yet. Without this, every fresh
    // install shows an empty layout-editor page with no screens to
    // edit - exactly the "layouts not rendered" complaint. We only
    // seed if the layout is missing OR has no screens; once the
    // operator has any screens we never overwrite.
    const def = this.store.profiles.profiles.default
    if (def && this.shouldSeedDefaultLayout(def)) {
      this.seedDefaultLayout(def)
    }
    return { profiles: Object.values(this.store.profiles.profiles) }
  }

  shouldSeedDefaultLayout (profile) {
    if (!profile || !profile.config) return true
    const layout = profile.config.layout
    if (!layout) return true
    if (!Array.isArray(layout.screens)) return true
    return layout.screens.length === 0
  }

  seedDefaultLayout (profile) {
    // The default profile is display-class-agnostic at registration,
    // so we seed with the 4-tile sunton (square) catalogue - it
    // degrades gracefully on wide displays (still renders, just
    // empty space). Wide-display devices get their own profile
    // recommendation in the editor's display-class selector.
    const presets = require('./screen-presets')
    const screens = presets.getPresetsForClass('sunton-480')
    if (!profile.config) profile.config = {}
    profile.config.layout = { version: 1, screens }
    profile.version = Number(profile.version || 1) + 1
    profile.updatedAt = now()
    profile.hash = sha256Json(profile.config)
    this.store.profiles.profiles[profile.id] = profile
    this.store.saveProfiles()
    this.store.audit('profile.seeded', profile.id, { screens: screens.length })
  }

  upsertProfile (profile) {
    if (!profile.id) throw httpError(400, 'invalid_request', 'profile.id is required')
    profile.version = Number(profile.version || 1)
    profile.updatedAt = now()
    profile.hash = sha256Json(profile.config || {})
    this.store.profiles.profiles[profile.id] = profile
    this.store.saveProfiles()
    this.store.audit('profile.upserted', profile.id)
    return profile
  }

  // Device cleanup: remove a device from the registry + any pending
  // commands + its discovery record. Idempotent - missing device is
  // not an error so the form can return the operator to a clean
  // list without races.
  deleteDevice (id) {
    if (!this.store.registry.devices[id]) return { id, removed: false }
    delete this.store.registry.devices[id]
    if (this.secrets) this.secrets.remove(id)
    // Drop pending commands aimed at this device.
    if (this.store.commands && this.store.commands.queues) {
      delete this.store.commands.queues[id]
    }
    // Drop discovery record so it doesn't reappear with stale state.
    if (this.store.discovery && this.store.discovery.devices) {
      Object.keys(this.store.discovery.devices).forEach((key) => {
        const rec = this.store.discovery.devices[key]
        if (rec && rec.deviceId === id) delete this.store.discovery.devices[key]
      })
    }
    this.store.saveRegistry()
    if (this.store.saveCommands) this.store.saveCommands()
    if (this.store.saveDiscovery) this.store.saveDiscovery()
    this.store.audit('device.deleted', id)
    return { id, removed: true }
  }

  // Bulk cleanup: remove every registered device that isn't currently online
  // (registries accumulate stale/mock entries — see the network-conflict fix).
  deleteOfflineDevices () {
    const ids = Object.values(this.store.registry.devices)
      .filter((device) => !this.isDeviceOnline(device))
      .map((device) => device.id)
    ids.forEach((id) => this.deleteDevice(id))
    return { removed: ids.length, remaining: Object.keys(this.store.registry.devices).length }
  }

  // Bulk cleanup: remove ALL registered devices (full reset of the list).
  clearAllDevices () {
    const ids = Object.keys(this.store.registry.devices)
    ids.forEach((id) => this.deleteDevice(id))
    return { removed: ids.length, remaining: Object.keys(this.store.registry.devices).length }
  }

  // Firmware artifact cleanup: drop an artifact from the catalog.
  // Active jobs that referenced it keep going to completion; we
  // just stop offering it to new updates.
  deleteFirmwareArtifact (artifactId) {
    if (!this.store.firmware || !this.store.firmware.artifacts) {
      return { artifactId, removed: false }
    }
    const before = this.store.firmware.artifacts.length
    this.store.firmware.artifacts = this.store.firmware.artifacts
      .filter((a) => a.artifactId !== artifactId)
    const removed = before !== this.store.firmware.artifacts.length
    if (removed) {
      this.store.saveFirmware()
      this.store.audit('firmware.artifact.deleted', artifactId)
    }
    return { artifactId, removed }
  }

  matchProfileForDevice (device) {
    const display = this.resolveDisplay(device)
    const profiles = Object.values(this.store.profiles.profiles)
      .filter((profile) => profile.id !== 'default' && profile.match)
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))
    const matched = profiles.find((profile) => this.profileMatches(profile, device, display))
    return matched ? matched.id : null
  }

  profileMatches (profile, device, display) {
    const match = profile.match || {}
    if (match.role && match.role !== device.role) return false
    if (match.location && match.location !== device.location) return false
    return this.variantMatches(match, device, display)
  }

  createCommand (id, body) {
    this.getDevice(id)
    if (!body.type) throw httpError(400, 'invalid_request', 'command type is required')
    const command = {
      id: body.id || randomId('cmd'),
      deviceId: id,
      type: body.type,
      status: 'pending',
      createdAt: now(),
      expiresAt: body.expiresAt || new Date(Date.now() + 60000).toISOString(),
      requiresAck: body.requiresAck !== false,
      payload: body.payload || {},
      result: null
    }
    this.store.commands.commands.push(command)
    this.store.saveCommands()
    this.store.audit('command.created', id, { commandId: command.id, type: command.type })
    // Push-live: a config.reload command is normally picked up on the device's
    // command poll. Also emit a configPush SignalK delta so a subscribed device
    // fetches the new generated config immediately (the firmware's onText sees
    // it and requests a config fetch). Best-effort; the poll remains the
    // fallback.
    if (command.type === 'config.reload' && this.app && typeof this.app.handleMessage === 'function') {
      try {
        this.app.handleMessage('yey-boats-display-manager', {
          updates: [{
            values: [{
              path: 'network.yeyboats.configPush',
              value: { deviceId: id, at: command.createdAt, payload: command.payload }
            }]
          }]
        })
      } catch (e) {
        if (this.app.debug) this.app.debug(`configPush emit failed: ${e.message}`)
      }
    }
    // Protocol-routed screen change. A `screen.set` is the manager's
    // cross-device view switch; when the target speaks the yeyboats control
    // protocol over IP we drive it directly with attach->switch->detach via
    // the shared @yeyboats/proto client (so the target shows this plugin's
    // colored frame), in addition to queueing the command. The command queue
    // stays as the fallback for devices that do not yet speak the protocol.
    const device = this.store.registry.devices[id]
    if (command.type === 'screen.set' && this.options.control.enabled &&
        ProtoControl.speaksProtocol(device)) {
      const viewId = command.payload && (command.payload.screen || command.payload.viewId || command.payload.view)
      if (viewId) {
        // Fire-and-forget: never block command creation on a network round-trip.
        this.protoSetScreen(id, String(viewId)).catch((e) => {
          if (this.app && this.app.debug) this.app.debug(`proto screen.set failed: ${e.message}`)
        })
      }
    }
    return command
  }

  // Build the descriptor proto-control needs for a registered device: a base
  // URL and the device's advertised protocol version / transports. Returns
  // null when the device has no known address.
  protoDeviceDescriptor (device) {
    let base
    try {
      base = this.deviceHttpBase(device)
    } catch (err) {
      return null
    }
    return {
      deviceId: device.id,
      base,
      pv: (device.proto && device.proto.pv) || device.pv || null,
      transports: (device.proto && device.proto.transports) ||
        device.transports || ['ip']
    }
  }

  // Discover the protocol DeviceRecord for every registered device that has a
  // known address, filtering out version-incompatible targets. Returns the
  // array of successful describeDevice results (each annotated with pv +
  // transports), and records pv/transports back onto the registry so the
  // registry "speaks the protocol".
  async protoDiscover () {
    const descriptors = Object.values(this.store.registry.devices)
      .map((device) => this.protoDeviceDescriptor(device))
      .filter(Boolean)
    const found = await this.protoControl.discover(descriptors)
    let changed = false
    for (const desc of found) {
      const device = this.store.registry.devices[desc.record.deviceId] ||
        Object.values(this.store.registry.devices).find((d) => this.deviceBaseSafe(d) === desc.base)
      if (device) {
        device.proto = {
          pv: desc.pv,
          transports: desc.transports,
          discoveredAt: now()
        }
        changed = true
      }
    }
    if (changed) this.store.saveRegistry()
    return found
  }

  deviceBaseSafe (device) {
    try { return this.deviceHttpBase(device) } catch (e) { return null }
  }

  // Drive a single device's screen change through the control protocol
  // (attach -> switch -> detach). Returns the proto-control result.
  async protoSetScreen (id, viewId) {
    const device = this.getDevice(id)
    const descriptor = this.protoDeviceDescriptor(device)
    if (!descriptor) return { ok: false, reason: 'no_address' }
    const result = await this.protoControl.setScreen(descriptor, viewId)
    if (result.ok) {
      this.store.audit('device.screen.set', id, { viewId, via: 'control-protocol' })
    }
    return result
  }

  queueConfigReload (id, opts) {
    const config = this.generateConfig(id)
    const payload = {
      version: config.version,
      hash: config.hash,
      url: `/plugins/yey-boats-display-manager/devices/${id}/config`
    }
    if (opts && opts.coalesce) {
      // PR #27 review: replace a still-pending re-push instead of appending.
      const pending = this.pendingCommands(id).find((c) => c.type === 'config.reload' && c.status === 'pending')
      if (pending) {
        pending.payload = payload
        pending.expiresAt = new Date(Date.now() + 60000).toISOString()
        this.store.saveCommands()
        return pending
      }
    }
    return this.createCommand(id, { type: 'config.reload', payload })
  }

  cancelCommand (id, commandId, reason) {
    const cmd = this.getCommand(id, commandId)
    if (cmd.status === 'acknowledged' || cmd.status === 'failed') {
      throw httpError(409, 'conflict', `cannot cancel ${cmd.status} command`)
    }
    cmd.status = 'cancelled'
    cmd.cancelledAt = now()
    cmd.result = { ok: false, code: 'cancelled', message: reason || 'cancelled' }
    this.store.saveCommands()
    this.store.audit('command.cancelled', id, { commandId })
    return cmd
  }

  expireCommands () {
    const nowMs = Date.now()
    let changed = false
    this.store.commands.commands.forEach((cmd) => {
      if ((cmd.status === 'pending' || cmd.status === 'delivered') &&
          Date.parse(cmd.expiresAt) <= nowMs) {
        cmd.status = 'expired'
        cmd.expiredAt = now()
        cmd.result = { ok: false, code: 'command_expired', message: 'command expired' }
        changed = true
      }
    })
    if (this.pruneFinishedCommands(nowMs)) changed = true
    if (changed) this.store.saveCommands()
  }

  // PR #27 review: acknowledged / failed / expired / cancelled commands are
  // dropped after FINISHED_COMMAND_TTL_MS, and only the newest
  // FINISHED_COMMANDS_PER_DEVICE are kept per display.
  pruneFinishedCommands (nowMs = Date.now()) {
    const list = this.store.commands.commands
    const finished = (c) => c.status !== 'pending' && c.status !== 'delivered'
    const perDevice = new Map()
    const keep = []
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i]
      if (finished(c)) {
        const t = Date.parse(c.acknowledgedAt || c.expiredAt || c.cancelledAt || c.createdAt || '') || nowMs
        if (nowMs - t > FINISHED_COMMAND_TTL_MS) continue
        const n = perDevice.get(c.deviceId) || 0
        if (n >= FINISHED_COMMANDS_PER_DEVICE) continue
        perDevice.set(c.deviceId, n + 1)
      }
      keep.push(c)
    }
    if (keep.length === list.length) return false
    keep.reverse()
    this.store.commands.commands = keep
    return true
  }

  createGroupCommand (groupId, body) {
    const devices = this.devicesInGroup(groupId)
    // Validator on push: a config.reload sends each display its layout.
    if (body && body.type === 'config.reload') this.requireValidLayouts(devices.map((d) => d.id), () => ({}))
    const commands = devices.map((device) => this.createCommand(device.id, body))
    return {
      groupId,
      count: commands.length,
      commands
    }
  }

  automationEvent (body) {
    const event = {
      id: body.id || randomId('evt'),
      type: body.type || 'external',
      createdAt: now(),
      source: body.source || 'api',
      payload: body.payload || {}
    }
    const actions = []
    if (body.command && body.deviceId) {
      actions.push(this.createCommand(body.deviceId, body.command))
    }
    if (body.command && body.groupId) {
      actions.push(this.createGroupCommand(body.groupId, body.command))
    }
    this.store.audit('automation.event', event.id, { event, actionCount: actions.length })
    return { event, actions }
  }

  getCommands (id, auth, limit) {
    this.requireDeviceAuth(id, auth)
    this.expireCommands()
    const nowMs = Date.now()
    const commands = this.store.commands.commands
      .filter((cmd) => cmd.deviceId === id && cmd.status === 'pending')
      .filter((cmd) => Date.parse(cmd.expiresAt) > nowMs)
      .slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)))

    commands.forEach((cmd) => {
      cmd.status = 'delivered'
      cmd.deliveredAt = now()
    })
    if (commands.length > 0) this.store.saveCommands()
    return { commands }
  }

  getCommand (id, commandId) {
    this.getDevice(id)
    this.expireCommands()
    const cmd = this.store.commands.commands.find((c) => c.deviceId === id && c.id === commandId)
    if (!cmd) throw httpError(404, 'command_not_found', 'command not found')
    return cmd
  }

  ackCommand (id, commandId, body, auth) {
    this.requireDeviceAuth(id, auth)
    const cmd = this.store.commands.commands.find((c) => c.deviceId === id && c.id === commandId)
    if (!cmd) throw httpError(404, 'command_not_found', 'command not found')
    const ok = body && body.result && body.result.ok !== false
    cmd.status = ok ? 'acknowledged' : 'failed'
    cmd.acknowledgedAt = now()
    cmd.result = body.result || body
    this.store.saveCommands()
    this.store.audit(`command.${cmd.status}`, id, { commandId })
    return { status: cmd.status, result: cmd.result }
  }

  pendingCommands (id) {
    this.expireCommands()
    const nowMs = Date.now()
    return this.store.commands.commands.filter((cmd) => {
      return cmd.deviceId === id &&
        (cmd.status === 'pending' || cmd.status === 'delivered') &&
        Date.parse(cmd.expiresAt) > nowMs
    })
  }

  devicesInGroup (groupId) {
    const id = String(groupId || '').toLowerCase()
    const devices = Object.values(this.store.registry.devices)
    if (id === 'all') return devices
    return devices.filter((device) => {
      return String(device.role || '').toLowerCase() === id ||
        String(device.location || '').toLowerCase() === id
    })
  }

  // #23: outside the dev auth modes a rotation is a Re-claim: the plaintext
  // token is never returned, and the display keeps its current token until it
  // has collected the new one.
  rotateDeviceToken (id) {
    const device = this.getDevice(id)
    if (this.isDevAuthMode()) return this.rotateDeviceTokenDev(device)
    return this.reclaimDevice(id, {})
  }

  rotateDeviceTokenDev (device) {
    const token = generateDeviceToken()
    this.setDeviceToken(device, token)
    device.updatedAt = now()
    this.store.saveRegistry()
    this.store.audit('device.token.rotated', device.id, { tokenId: device.deviceTokenId })
    return {
      deviceId: device.id,
      tokenId: device.deviceTokenId,
      deviceToken: token
    }
  }

  revokeDeviceToken (id) {
    const device = this.getDevice(id)
    device.deviceTokenHash = null
    delete device.deviceToken
    delete device.legacyTokenHash
    delete device.pendingTokenHash
    delete device.tokenDelivery
    delete device.reclaim
    this.secrets.clearPendingManagerToken(id)
    device.deviceTokenId = null
    device.updatedAt = now()
    this.store.saveRegistry()
    this.store.audit('device.token.revoked', id)
    return { deviceId: id, revoked: true }
  }

  listFirmware () {
    return clone(this.store.firmware)
  }

  firmwareUpgradeMatrix () {
    const artifacts = this.store.firmware.artifacts
      .slice()
      .sort(compareFirmwareArtifacts)
    const jobs = this.store.jobs.jobs
    const devices = Object.values(this.store.registry.devices)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((device) => {
        const currentVersion = firmwareVersionFromDevice(device)
        const board = device.board ||
          (device.identity && (device.identity.board || device.identity.board_id)) ||
          null
        const chip = device.identity && device.identity.chip ? device.identity.chip : null
        const compatibleArtifacts = artifacts
          .map((artifact) => {
            const compatibility = this.firmwareCompatibility(device, artifact)
            return {
              ...clone(artifact),
              compatible: compatibility.compatible,
              reason: compatibility.reason,
              sameVersion: Boolean(currentVersion && artifact.firmware && artifact.firmware.version === currentVersion)
            }
          })
          .filter((artifact) => artifact.compatible)
        const availableArtifacts = compatibleArtifacts.filter((artifact) => !artifact.sameVersion)
        const activeJobs = jobs
          .filter((job) => job.deviceId === device.id && !['confirmed', 'failed', 'cancelled'].includes(job.status))
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        const latest = availableArtifacts[0] || null
        return {
          deviceId: device.id,
          name: device.name || device.id,
          online: isDeviceOnline(device, this.options.heartbeatMs),
          board,
          chip,
          currentVersion,
          firmware: clone(device.firmware || null),
          compatibleArtifacts,
          availableArtifacts,
          latestArtifact: latest,
          upgradable: Boolean(latest),
          activeJobs,
          status: activeJobs.length > 0
            ? 'update queued'
            : latest
              ? 'upgrade available'
              : compatibleArtifacts.length > 0
                ? 'current'
                : 'no compatible artifact'
        }
      })
    return {
      generatedAt: now(),
      devices,
      artifacts: clone(artifacts),
      upgradable: devices.filter((device) => device.upgradable).length
    }
  }

  firmwareCompatibility (device, artifact) {
    try {
      this.validateFirmwareCompatibility(device, artifact)
      return { compatible: true }
    } catch (err) {
      return {
        compatible: false,
        reason: err && err.payload && err.payload.error
          ? err.payload.error.message
          : err.message
      }
    }
  }

  // Pre-flight for the device-detail "Update Firmware" control: reports whether
  // the device is registered, currently online (same predicate the device table
  // / firmware upgrade summary use — isDeviceOnline), reachable at a known
  // address, and whether the catalogue has any artifact. `ready` is the AND of
  // those, so the UI can disable the OTA submit when an OTA can't succeed.
  validateOtaTarget (deviceId) {
    const d = this.store.registry.devices[deviceId]
    if (!d) return { exists: false, online: false, addressKnown: false, hasArtifact: false, ready: false }
    const online = isDeviceOnline(d, this.options.heartbeatMs)
    // Real registry address sources, mirroring deviceHttpCandidates(): the
    // heartbeat-reported IP (status.network.ip), the resolved mDNS address /
    // FQDN on networkIdentity, or a discovery-supplied device.address.
    const ni = (d.networkIdentity) || {}
    const addressKnown = Boolean(
      (d.status && d.status.network && d.status.network.ip) ||
      ni.lastResolvedAddress || ni.currentFqdn || ni.desiredFqdn ||
      d.address
    )
    const hasArtifact = (this.store.firmware.artifacts || []).length > 0
    return { exists: true, online, addressKnown, hasArtifact, ready: Boolean(online && addressKnown && hasArtifact) }
  }

  async refreshFirmwareFromGithub (fetchImpl) {
    const cfg = this.options.firmware.github
    if (!cfg.enabled) return this.listFirmware()
    // MGR-5: apiBase is fetch()ed server-side; reject a non-https / off-allowlist
    // override rather than let it point the manager at arbitrary hosts.
    if (cfg.apiBase) assertAllowedFirmwareUrl(cfg.apiBase, 'firmware.github.apiBase')
    const doFetch = fetchImpl || cfg.fetch || globalThis.fetch
    if (typeof doFetch !== 'function') {
      throw httpError(500, 'github_fetch_unavailable', 'fetch is not available in this Node runtime')
    }

    // The firmware repo publishes a rolling `tip` PRERELEASE on every main
    // push plus tagged `vX.Y.Z` releases (some prerelease for -rc/-alpha/
    // -beta). We import them all and tag each artifact with a `source.kind`
    // ('tip' | 'prerelease' | 'release') so the flash UI can filter
    // RELEASES (+tip) vs ALL. The `tip` build is always fetched explicitly
    // (releases/tags/tip) so it appears even when includePrereleases is off.
    const releases = await collectGithubReleases(cfg, doFetch)
    if (!releases.length) throw httpError(404, 'github_release_not_found', 'no GitHub release found')

    const targets = cfg.targets && cfg.targets.length
      ? cfg.targets.map(normalizeFirmwareTarget)
      : SUPPORTED_FIRMWARE_TARGETS
    const imported = []
    let primaryTag = null
    for (const release of releases) {
      const assets = Array.isArray(release.assets) ? release.assets : []
      const sumsAsset = assets.find((asset) => asset.name === 'SHA256SUMS')
      const sums = sumsAsset && sumsAsset.browser_download_url
        ? parseSha256Sums(await fetchText(sumsAsset.browser_download_url, doFetch))
        : {}
      const tag = release.tag_name || release.name || 'unknown'
      const kind = firmwareSourceKind(tag, release.prerelease)
      if (!primaryTag && kind === 'release') primaryTag = tag
      for (const entry of targets) {
        const target = entry.target
        const assetName = `${target}-merged_firmware.bin`
        const asset = assets.find((candidate) => candidate.name === assetName)
        if (!asset || !asset.browser_download_url) continue
        const sha = sums[assetName]
        if (!sha) continue
        const version = String(tag).replace(/^v/, '')
        const artifact = {
          artifactId: `github-${sanitizeArtifactId(tag)}-${target}`,
          source: {
            type: 'github-release',
            kind,
            tag,
            prerelease: Boolean(release.prerelease),
            owner: cfg.owner,
            repo: cfg.repo,
            htmlUrl: release.html_url || null,
            assetUrl: asset.browser_download_url
          },
          vendor: { id: 'yey-boats', name: 'Yey Boats Project', trust: { level: 'github-release', allowUnsigned: false } },
          product: { id: 'yey-display', name: 'YEY Display' },
          firmware: {
            name: 'yey-display',
            version,
            channel: release.prerelease ? 'prerelease' : 'stable'
          },
          compatibility: {
            boards: [entry.board],
            releaseTarget: target,
            chip: 'ESP32-S3',
            minFlashBytes: 16777216,
            requiresPsram: true,
            partitionScheme: 'ota_16mb'
          },
          file: {
            name: asset.name,
            size: Number(asset.size || 0),
            sha256: `sha256:${sha}`,
            url: asset.browser_download_url,
            contentType: asset.content_type || 'application/octet-stream'
          },
          signing: { signed: false, checksums: 'SHA256SUMS' },
          uploadedAt: now()
        }
        upsertFirmwareArtifact(this.store.firmware.artifacts, artifact)
        imported.push(artifact)
      }
    }
    if (!primaryTag) primaryTag = releases[0].tag_name || null
    this.store.firmware.github = {
      owner: cfg.owner,
      repo: cfg.repo,
      release: primaryTag,
      checkedAt: now(),
      imported: imported.length
    }
    this.store.saveFirmware()
    this.store.audit('firmware.github.refresh', `${cfg.owner}/${cfg.repo}`, {
      release: primaryTag,
      imported: imported.map((artifact) => artifact.artifactId)
    })
    return { ...this.listFirmware(), refreshed: this.store.firmware.github }
  }

  // TIP build source: instead of a GitHub release (a rolling `tip` tag is
  // impossible on this repo — tag creation is ruleset-restricted), the
  // firmware repo's CI uploads one Actions artifact per board env named
  // `firmware-<target>-latest` on every successful push to main. Each is a
  // ZIP containing merged_firmware.bin (+ others). We find the newest
  // successful main CI run, list its artifacts, and create/replace a
  // `tip-<target>` artifact record per matching board. The binary itself is
  // not downloaded here — firmwareArtifactBinary fetches+extracts it on
  // demand (downloading Actions artifacts requires auth, hence the token).
  async refreshTipFromArtifacts (fetchImpl) {
    const cfg = this.options.firmware.github
    if (!cfg.tipFromArtifacts) return this.listFirmware()
    // MGR-5: validate the (server-side fetched) API base before using it.
    if (cfg.apiBase) assertAllowedFirmwareUrl(cfg.apiBase, 'firmware.github.apiBase')
    if (!cfg.token) {
      // No token → cannot download Actions artifacts. Skip quietly, but log
      // once so an operator who expects TIP builds knows why they're absent.
      if (!this._tipNoTokenLogged) {
        this._tipNoTokenLogged = true
        if (this.app && this.app.debug) {
          this.app.debug('yey-display TIP-from-artifacts skipped: no GitHub token configured (firmware.github.token)')
        }
      }
      return this.listFirmware()
    }
    const doFetch = fetchImpl || cfg.fetch || globalThis.fetch
    if (typeof doFetch !== 'function') {
      throw httpError(500, 'github_fetch_unavailable', 'fetch is not available in this Node runtime')
    }

    const base = String(cfg.apiBase || 'https://api.github.com').replace(/\/$/, '')
    const headers = githubAuthHeaders(cfg.token)

    // 1. Newest successful main push run of the CI workflow.
    const runsUrl = `${base}/repos/${cfg.owner}/${cfg.repo}/actions/runs?branch=main&event=push&status=success&per_page=10`
    const runsPayload = await fetchJson(runsUrl, doFetch, headers)
    const runs = Array.isArray(runsPayload && runsPayload.workflow_runs) ? runsPayload.workflow_runs : []
    if (!runs.length) {
      if (this.app && this.app.debug) this.app.debug('yey-display TIP-from-artifacts: no successful main runs found')
      return this.listFirmware()
    }
    const ciRun = runs.find((r) => String(r.name || '').toUpperCase() === 'CI') || runs[0]

    // 2. Version MAJOR.MINOR from the repo VERSION file (fall back to 0.0).
    let majorMinor = '0.0'
    try {
      const contents = await fetchJson(`${base}/repos/${cfg.owner}/${cfg.repo}/contents/VERSION?ref=main`, doFetch, headers)
      if (contents && contents.content) {
        const decoded = Buffer.from(String(contents.content), contents.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
        const parts = decoded.trim().split('.')
        if (parts.length >= 2 && parts[0] !== '') majorMinor = `${parts[0]}.${parts[1]}`
      }
    } catch (err) {
      if (this.app && this.app.debug) this.app.debug(`yey-display TIP version lookup failed, using 0.0: ${err.message}`)
    }

    // 3. List the run's artifacts; map firmware-<target>-latest -> record.
    const artifactsUrl = `${base}/repos/${cfg.owner}/${cfg.repo}/actions/runs/${ciRun.id}/artifacts`
    const artifactsPayload = await fetchJson(artifactsUrl, doFetch, headers)
    const ghArtifacts = Array.isArray(artifactsPayload && artifactsPayload.artifacts) ? artifactsPayload.artifacts : []
    const targets = SUPPORTED_FIRMWARE_TARGETS
    const runNumber = ciRun.run_number != null ? ciRun.run_number : 0
    const version = `${majorMinor}.${runNumber}`
    const imported = []
    const liveIds = new Set()

    for (const gh of ghArtifacts) {
      const m = String(gh.name || '').match(/^firmware-(.+)-latest$/)
      if (!m) continue
      const target = m[1]
      const entry = targets.find((t) => t.target === target)
      if (!entry) continue
      const artifactId = `tip-${target}`
      liveIds.add(artifactId)
      const artifact = {
        artifactId,
        source: {
          type: 'github-actions-artifact',
          kind: 'tip',
          owner: cfg.owner,
          repo: cfg.repo,
          runId: ciRun.id,
          runNumber,
          headSha: ciRun.head_sha || null,
          htmlUrl: ciRun.html_url || null,
          createdAt: ciRun.created_at || null,
          artifactId: gh.id,
          archiveUrl: gh.archive_download_url || null,
          expiresAt: gh.expires_at || null
        },
        vendor: { id: 'yey-boats', name: 'Yey Boats Project', trust: { level: 'github-actions-artifact', allowUnsigned: true } },
        product: { id: 'yey-display', name: 'YEY Display' },
        firmware: {
          name: 'yey-display',
          version,
          channel: 'tip'
        },
        compatibility: {
          boards: [entry.board],
          releaseTarget: target,
          chip: 'ESP32-S3',
          minFlashBytes: 16777216,
          requiresPsram: true,
          partitionScheme: 'ota_16mb'
        },
        file: {
          name: 'merged_firmware.bin',
          kind: 'actions-artifact',
          artifactId: gh.id,
          url: gh.archive_download_url || null,
          contentType: 'application/octet-stream'
        },
        signing: { signed: false, checksums: null },
        uploadedAt: now()
      }
      upsertFirmwareArtifact(this.store.firmware.artifacts, artifact)
      imported.push(artifact)
    }

    // 4. Prune stale tip-* records that are no longer in the latest run.
    this.store.firmware.artifacts = (this.store.firmware.artifacts || []).filter((a) => {
      const isTip = a && a.source && a.source.kind === 'tip'
      if (!isTip) return true
      return liveIds.has(a.artifactId)
    })

    this.store.firmware.githubTip = {
      owner: cfg.owner,
      repo: cfg.repo,
      runId: ciRun.id,
      runNumber,
      headSha: ciRun.head_sha || null,
      version,
      checkedAt: now(),
      imported: imported.length
    }
    this.store.saveFirmware()
    this.store.audit('firmware.github.tip.refresh', `${cfg.owner}/${cfg.repo}`, {
      runId: ciRun.id,
      runNumber,
      imported: imported.map((a) => a.artifactId)
    })
    return { ...this.listFirmware(), tip: this.store.firmware.githubTip }
  }

  addFirmwareArtifact (body) {
    if (!body.vendor || !body.vendor.id) throw httpError(400, 'invalid_request', 'vendor.id is required')
    if (!body.product || !body.product.id) throw httpError(400, 'invalid_request', 'product.id is required')
    if (!body.firmware || !body.firmware.version) throw httpError(400, 'invalid_request', 'firmware.version is required')
    if (!body.file || !body.file.sha256) throw httpError(400, 'invalid_request', 'file.sha256 is required')
    // MGR-5: the URL is fetch()ed server-side later; require https + an
    // allowlisted host at ingest so this route can't be turned into an open
    // fetch proxy toward LAN / cloud-metadata endpoints.
    if (body.file.url) assertAllowedFirmwareUrl(body.file.url, 'file.url')
    const artifact = {
      ...body,
      artifactId: body.artifactId || randomId('fw'),
      uploadedAt: now()
    }
    this.store.firmware.artifacts.push(artifact)
    this.store.saveFirmware()
    this.store.audit('firmware.artifact.added', artifact.artifactId)
    return artifact
  }

  getFirmwareArtifact (artifactId) {
    const artifact = this.store.firmware.artifacts.find((fw) => fw.artifactId === artifactId)
    if (!artifact) throw httpError(404, 'artifact_not_found', 'firmware artifact not found')
    return artifact
  }

  createFirmwareJob (id, body) {
    const device = this.getDevice(id)
    const artifact = this.store.firmware.artifacts.find((fw) => fw.artifactId === body.artifactId)
    if (!artifact) throw httpError(404, 'artifact_not_found', 'firmware artifact not found')
    this.validateFirmwareCompatibility(device, artifact)
    const job = {
      jobId: randomId('ota-job'),
      deviceId: id,
      artifactId: artifact.artifactId,
      status: 'queued',
      createdAt: now(),
      policy: body.policy || { reboot: true, confirmAfterBoot: true, rollbackOnFailure: true },
      progress: { state: 'queued', bytesRead: 0, bytesTotal: artifact.file ? artifact.file.size : 0 }
    }
    this.store.jobs.jobs.push(job)
    this.store.saveJobs()
    this.createCommand(id, {
      type: 'firmware.update',
      expiresAt: body.expiresAt,
      payload: {
        jobId: job.jobId,
        artifactId: artifact.artifactId,
        version: artifact.firmware && artifact.firmware.version,
        // Manager-relative path: the device build_url()s it against the plugin
        // base and pulls over plain LAN HTTP. The manager (host) does the
        // GitHub TLS/redirects and streams the binary — the heap-constrained
        // device never does HTTPS. (was: the remote artifact URL directly.)
        url: `/firmware/download/${job.jobId}`,
        sha256: firmwarePayloadSha256(artifact.file && artifact.file.sha256),
        size: artifact.file && artifact.file.size,
        mode: 'pull',
        reboot: job.policy.reboot,
        confirmAfterBoot: job.policy.confirmAfterBoot
      }
    })
    return job
  }

  listFirmwareJobs (id) {
    this.getDevice(id)
    return {
      jobs: this.store.jobs.jobs.filter((job) => job.deviceId === id)
    }
  }

  getFirmwareJob (id, jobId) {
    this.getDevice(id)
    const job = this.store.jobs.jobs.find((j) => j.deviceId === id && j.jobId === jobId)
    if (!job) throw httpError(404, 'job_not_found', 'firmware job not found')
    return job
  }

  firmwareManifest (artifactId) {
    const a = (this.store.firmware.artifacts || []).find((x) => x.artifactId === artifactId)
    if (!a) return null
    // GitHub-sourced artifacts store the version under firmware.version;
    // operator-uploaded fixtures may carry a top-level `version`. Prefer the
    // structured field, then the legacy one, then a placeholder.
    const version = (a.firmware && a.firmware.version) || a.version || '0'
    return {
      name: 'yey-display',
      version,
      new_install_prompt_erase: true,
      builds: [{
        chipFamily: (a.compatibility && a.compatibility.chip) || 'ESP32-S3',
        parts: [{ path: `/plugins/yey-boats-display-manager/firmware/artifacts/${encodeURIComponent(artifactId)}/binary`, offset: 0 }]
      }]
    }
  }

  firmwareArtifactFile (artifactId) {
    const a = (this.store.firmware.artifacts || []).find((x) => x.artifactId === artifactId)
    return a && a.file && a.file.path ? a.file : null
  }

  // Resolve a same-origin-streamable binary for an artifact. Local uploads
  // already have file.path. GitHub-sourced artifacts only carry file.url, so
  // we download-on-demand into a PSRAM-free local cache under the plugin data
  // dir, verify against file.sha256, and reuse it on subsequent flashes. This
  // keeps the actual Web Serial flashing browser-local (the browser streams
  // from this same-origin route) while never proxying GitHub through the
  // device/network. Returns { path, name, size, contentType } or null.
  // MGR-4: record a computed sha256 (bare hex) for an artifact's binary so
  // later serves self-verify through the same machinery as sha'd releases.
  // Marks the signing block as checksum-covered (still unsigned, still an
  // allowUnsigned build) so the UI can distinguish "no integrity at all" from
  // "integrity rooted at extraction".
  _persistArtifactSha (artifact, bareHash, size) {
    if (!artifact || !artifact.file || !bareHash) return
    artifact.file.sha256 = `sha256:${bareHash}`
    if (size != null) artifact.file.size = size
    if (artifact.signing && artifact.signing.checksums == null) {
      artifact.signing.checksums = 'sha256-extracted'
    }
    try {
      this.store.saveFirmware()
    } catch (err) {
      if (this.app && this.app.debug) {
        this.app.debug(`yey-display: failed to persist extracted sha for ${artifact.artifactId}: ${err.message}`)
      }
    }
  }

  async firmwareArtifactBinary (artifactId, fetchImpl) {
    const a = (this.store.firmware.artifacts || []).find((x) => x.artifactId === artifactId)
    if (!a || !a.file) return null
    if (a.file.path && fs.existsSync(a.file.path)) {
      return { path: a.file.path, name: a.file.name, size: a.file.size, contentType: a.file.contentType }
    }
    if (!a.file.url) return null

    const cacheDir = path.join(this.store.dataDir || os.tmpdir(), 'firmware-cache')
    fs.mkdirSync(cacheDir, { recursive: true })
    const cachePath = path.join(cacheDir, `${sanitizeArtifactId(artifactId)}.bin`)
    const doFetch = fetchImpl || (this.options.firmware.github && this.options.firmware.github.fetch) || globalThis.fetch
    if (typeof doFetch !== 'function') {
      throw httpError(500, 'github_fetch_unavailable', 'fetch is not available to download firmware binary')
    }

    // TIP / CI Actions artifacts are delivered as a ZIP from the GitHub
    // archive_download_url. GitHub publishes no sha for Actions artifacts, so
    // we fetch the zip (auth required, then follow the 302 to the signed
    // storage URL WITHOUT the Authorization header), extract merged_firmware.bin
    // dependency-free, and cache it. MGR-4: we compute a sha256 of the extracted
    // binary and persist it to file.sha256 so every later cache hit/serve
    // self-verifies (the device still gets an integrity guarantee end-to-end,
    // rooted at first extraction rather than at the vendor).
    if (a.file.kind === 'actions-artifact') {
      const expected = firmwarePayloadSha256(a.file.sha256)
      if (fs.existsSync(cachePath)) {
        const actual = sha256OfFile(cachePath)
        if (expected) {
          // Recorded a hash on first extraction: refuse to serve a cache whose
          // bytes drifted (tampering, truncated write, ...).
          if (actual !== expected) {
            throw httpError(502, 'artifact_sha_mismatch', `cached TIP firmware checksum mismatch for ${artifactId}`)
          }
        } else if (actual) {
          // Backfill: a cache predating MGR-4 — record its hash now.
          this._persistArtifactSha(a, actual, fs.statSync(cachePath).size)
        }
        const st = fs.statSync(cachePath)
        return { path: cachePath, name: a.file.name, size: st.size, contentType: a.file.contentType }
      }
      const cfg = this.options.firmware.github || {}
      const zipBuf = await fetchActionsArtifactZip(a.file.url, cfg.token, doFetch)
      const binBuf = extractMergedFirmwareFromZip(zipBuf)
      if (!binBuf) {
        throw httpError(502, 'artifact_extract_failed', `merged_firmware.bin not found in Actions artifact zip for ${artifactId}`)
      }
      const hash = crypto.createHash('sha256').update(binBuf).digest('hex')
      // If we already recorded a sha for this artifact (a prior extraction),
      // the freshly-extracted bytes must still match it.
      if (expected && hash !== expected) {
        throw httpError(502, 'artifact_sha_mismatch', `extracted TIP firmware checksum mismatch for ${artifactId}`)
      }
      if (this.app && this.app.debug) {
        this.app.debug(`yey-display TIP artifact ${artifactId}: extracted merged_firmware.bin (${binBuf.length} bytes), sha256=${hash}`)
      }
      const tmp = `${cachePath}.${process.pid}.tmp`
      fs.writeFileSync(tmp, binBuf)
      fs.renameSync(tmp, cachePath)
      this._persistArtifactSha(a, hash, binBuf.length)
      return { path: cachePath, name: a.file.name, size: binBuf.length, contentType: a.file.contentType }
    }

    const expected = firmwarePayloadSha256(a.file.sha256)
    if (fs.existsSync(cachePath) && (!expected || sha256OfFile(cachePath) === expected)) {
      return { path: cachePath, name: a.file.name, size: a.file.size, contentType: a.file.contentType }
    }

    const response = await doFetch(a.file.url)
    if (!response || !response.ok) {
      throw httpError(502, 'artifact_download_failed', `failed to download firmware binary: ${a.file.url}`)
    }
    const buf = Buffer.from(await response.arrayBuffer())
    if (expected) {
      const actual = crypto.createHash('sha256').update(buf).digest('hex')
      if (actual !== expected) {
        throw httpError(502, 'artifact_sha_mismatch', `firmware binary checksum mismatch for ${artifactId}`)
      }
    }
    const tmp = `${cachePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, cachePath)
    return { path: cachePath, name: a.file.name, size: buf.length, contentType: a.file.contentType }
  }

  // Target -> board -> display-class/resolution table for the flash UI's
  // device-type + resolution selectors. Inlined into the page and exposed as
  // GET /firmware/targets.
  firmwareTargets () {
    const presets = require('./screen-presets')
    const classes = {}
    for (const c of presets.listDisplayClasses()) classes[c.id] = c
    return {
      targets: SUPPORTED_FIRMWARE_TARGETS.map((entry) => {
        const displayClass = presets.classifyBoard(entry.board)
        const meta = classes[displayClass] || {}
        return {
          target: entry.target,
          board: entry.board,
          displayClass,
          width: meta.width || null,
          height: meta.height || null,
          shape: meta.shape || null,
          resolution: meta.width && meta.height ? `${meta.width}×${meta.height}` : null,
          label: meta.label || entry.target
        }
      })
    }
  }

  firmwareDownloadInfo (jobId) {
    const job = this.store.jobs.jobs.find((j) => j.jobId === jobId)
    if (!job) throw httpError(404, 'job_not_found', 'firmware job not found')
    const artifact = this.getFirmwareArtifact(job.artifactId)
    if (!artifact.file || !artifact.file.path) {
      if (artifact.file && artifact.file.url) return { job, artifact }
      throw httpError(404, 'artifact_binary_missing', 'firmware binary is not stored in this test fixture')
    }
    return { job, artifact }
  }

  updateFirmwareProgress (id, jobId, body, auth) {
    this.requireDeviceAuth(id, auth)
    const job = this.store.jobs.jobs.find((j) => j.deviceId === id && j.jobId === jobId)
    if (!job) throw httpError(404, 'job_not_found', 'firmware job not found')
    job.status = body.state || job.status
    job.progress = { ...job.progress, ...body, updatedAt: now() }
    this.store.saveJobs()
    return job
  }

  confirmFirmware (id, body, auth) {
    this.requireDeviceAuth(id, auth)
    const job = this.store.jobs.jobs.find((j) => j.deviceId === id && j.jobId === body.jobId)
    if (!job) throw httpError(404, 'job_not_found', 'firmware job not found')
    job.status = 'confirmed'
    job.confirmedAt = now()
    job.confirmation = body
    this.store.saveJobs()
    this.store.audit('firmware.job.confirmed', id, { jobId: job.jobId })
    return job
  }

  resolveDisplay (device) {
    const source = device.display ||
      (device.identity && device.identity.display) ||
      {}
    return {
      width: Number(source.width || 480),
      height: Number(source.height || 480),
      rotation: Number(source.rotation || 0),
      colorDepth: Number(source.colorDepth || 16),
      density: source.density || 'mdpi',
      shape: source.shape || (Number(source.width || 480) === Number(source.height || 480) ? 'square' : 'wide'),
      safeArea: source.safeArea || {
        x: 0,
        y: 0,
        width: Number(source.width || 480),
        height: Number(source.height || 480)
      }
    }
  }

  resolveLayout (layout, device, display, widgets) {
    const selected = this.selectVariant(layout.variants || [], device, display)
    const screens = selected && selected.screens ? selected.screens : (layout.screens || [])
    const widgetItems = widgets && widgets.items ? widgets.items : {}
    const resolved = {
      ...clone(layout),
      variant: selected ? selected.id : layout.variant || null,
      screens: this.filterScreensByWidgets(screens, widgetItems)
    }
    delete resolved.variants
    return resolved
  }

  filterScreensByWidgets (screens, widgetItems) {
    return (screens || []).map((screen) => {
      if (!Array.isArray(screen.tiles)) return clone(screen)
      return {
        ...clone(screen),
        tiles: screen.tiles.filter((tile) => !tile.widget || widgetItems[tile.widget])
      }
    })
  }

  resolveWidgets (widgets, device, display) {
    const selected = this.selectVariant(widgets.variants || [], device, display)
    const defaults = mergeDeep(widgets.defaults || {}, selected && selected.defaults ? selected.defaults : {})
    const supported = device.capabilities && device.capabilities.widgets
      ? device.capabilities.widgets
      : {}
    const items = {}
    Object.keys(widgets.items || {}).forEach((id) => {
      const widget = widgets.items[id]
      if (!this.widgetSupported(widget, supported, device.capabilities || {})) return
      items[id] = {
        ...widget,
        fontSize: this.resolveFontSize(device, widget.fontSize || defaults.fontSize),
        labelFontSize: this.resolveFontSize(device, widget.labelFontSize || defaults.labelFontSize),
        valueFontSize: this.resolveFontSize(device, widget.valueFontSize || defaults.valueFontSize),
        unitFontSize: this.resolveFontSize(device, widget.unitFontSize || defaults.unitFontSize)
      }
    })
    return {
      version: widgets.version || 1,
      variant: selected ? selected.id : widgets.variant || null,
      defaults: {
        ...defaults,
        fontSize: this.resolveFontSize(device, defaults.fontSize),
        labelFontSize: this.resolveFontSize(device, defaults.labelFontSize),
        valueFontSize: this.resolveFontSize(device, defaults.valueFontSize),
        unitFontSize: this.resolveFontSize(device, defaults.unitFontSize)
      },
      items
    }
  }

  selectVariant (variants, device, display) {
    return variants.find((variant) => this.variantMatches(variant.match || {}, device, display)) || null
  }

  variantMatches (match, device, display) {
    if (match.board && match.board !== device.board) return false
    if (match.display) {
      if (match.display.width && Number(match.display.width) !== display.width) return false
      if (match.display.height && Number(match.display.height) !== display.height) return false
      if (match.display.shape && match.display.shape !== display.shape) return false
    }
    if (match.capabilities) {
      for (const key of Object.keys(match.capabilities)) {
        if (Boolean(device.capabilities && device.capabilities[key]) !== Boolean(match.capabilities[key])) {
          return false
        }
      }
    }
    return true
  }

  widgetSupported (widget, supportedWidgets, capabilities) {
    if (supportedWidgets && Object.prototype.hasOwnProperty.call(supportedWidgets, widget.type) &&
        supportedWidgets[widget.type] === false) {
      return false
    }
    if (widget.requires && widget.requires.capability &&
        capabilities[widget.requires.capability] !== true) {
      return false
    }
    return true
  }

  resolveFontSize (device, requested) {
    const size = Number(requested || 16)
    const fonts = device.capabilities && device.capabilities.fonts
    const supported = fonts && Array.isArray(fonts.sizes) && fonts.sizes.length > 0
      ? fonts.sizes.map(Number).sort((a, b) => a - b)
      : [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56]
    let best = supported[0]
    supported.forEach((candidate) => {
      if (candidate <= size) best = candidate
    })
    return best
  }

  validateFirmwareCompatibility (device, artifact) {
    const compatibility = artifact.compatibility || {}
    if (compatibility.boards && compatibility.boards.length > 0) {
      const board = device.board || (device.identity && (device.identity.board || device.identity.board_id))
      if (!compatibility.boards.includes(board)) {
        throw httpError(409, 'incompatible_firmware', 'firmware board is not compatible', {
          board,
          supportedBoards: compatibility.boards
        })
      }
    }
    if (compatibility.chip && device.identity && device.identity.chip &&
        !chipFamiliesMatch(compatibility.chip, device.identity.chip)) {
      throw httpError(409, 'incompatible_firmware', 'firmware chip is not compatible', {
        chip: device.identity.chip,
        requiredChip: compatibility.chip
      })
    }
  }

  createProvisioningToken (body) {
    const ttlMs = Number(body.ttlMs || 10 * 60 * 1000)
    const token = body.token || randomId('prov')
    const record = {
      id: randomId('prov-token'),
      tokenHash: hashToken(token),
      createdAt: now(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      usesRemaining: Number(body.uses || 1),
      note: body.note || ''
    }
    this.store.provisioning.tokens.push(record)
    this.store.saveProvisioning()
    this.store.audit('provisioning.token.created', record.id, { expiresAt: record.expiresAt })
    return { ...record, token }
  }

  listProvisioningTokens () {
    const nowMs = Date.now()
    return {
      tokens: this.store.provisioning.tokens.map((token) => ({
        id: token.id,
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
        usesRemaining: token.usesRemaining,
        expired: Date.parse(token.expiresAt) <= nowMs,
        note: token.note
      }))
    }
  }

  authStatus (id) {
    const device = this.getDevice(id)
    return {
      deviceId: id,
      tokenId: device.deviceTokenId || null,
      provisioned: deviceHasToken(device),
      claimed: Boolean(device.claimed),
      authMode: this.options.auth.mode,
      tokenMigration: device.tokenMigration || null,
      reclaim: device.reclaim ? { state: device.reclaim.state, method: device.reclaim.method || null, address: device.reclaim.address || null, requestedAt: device.reclaim.requestedAt || null } : null,
      tokenDelivery: device.tokenDelivery
        ? { state: device.tokenDelivery.state, attempts: device.tokenDelivery.attempts || 0, lastAttemptAt: device.tokenDelivery.lastAttemptAt || null, lastError: device.tokenDelivery.lastError || null }
        : null,
      webAuth: device.auth && device.auth.web
        ? device.auth.web
        : {
            required: false,
            mode: 'none',
            username: this.options.deviceWebAuth.username,
            passwordSet: Boolean(this.secrets.web(id))
          }
    }
  }

  resolveNetworkIdentity (device, incoming) {
    const base = device.networkIdentity || {}
    const desiredHostname = hostnameFromPolicy({ ...device, ...incoming }, this.options.network)
    const desiredDomain = this.options.network.domain || 'yey.boats'
    return {
      desiredHostname,
      desiredDomain,
      desiredFqdn: `${desiredHostname}.${desiredDomain}`,
      currentHostname: base.currentHostname || incoming.hostname || null,
      currentDomain: base.currentDomain || null,
      currentFqdn: base.currentFqdn || null,
      mdnsEnabled: base.mdnsEnabled !== false,
      conflict: this.hostnameConflict(device.id, desiredHostname),
      lastResolvedAddress: base.lastResolvedAddress || null
    }
  }

  // True only when the device was seen within the online window. Used so a
  // hostname "conflict" against a long-dead / mock registration doesn't flag a
  // live device as network-conflict (registries accumulate stale duplicates).
  isDeviceOnline (device) {
    if (!device || !device.lastSeen) return false
    const lastSeenMs = Date.parse(device.lastSeen)
    if (!(lastSeenMs > 0)) return false
    const onlineWindowMs = Math.max(this.options.heartbeatMs * 3, 15000)
    return Date.now() - lastSeenMs <= onlineWindowMs
  }

  hostnameConflict (id, hostname) {
    // A conflict is only real when ANOTHER currently-online device wants the
    // same hostname; stale/offline registrations are not actively competing for
    // it on the network.
    return Object.values(this.store.registry.devices).some((device) => {
      return device.id !== id &&
        device.networkIdentity &&
        device.networkIdentity.desiredHostname === hostname &&
        this.isDeviceOnline(device)
    })
  }

  configVersion (device) {
    const profile = this.store.profiles.profiles[device.assignedProfile || 'default'] ||
      this.store.profiles.profiles.default
    return Number(profile.version || 1)
  }

  isDevAuthMode () {
    return DEV_AUTH_MODES.includes(this.options.auth.mode)
  }

  // #23: is SignalK's own security on? SignalK hands plugins its security
  // strategy as app.securityStrategy; with security off it is the dummy
  // strategy (isDummy() === true), which lets everyone through, so it can't
  // vouch for an operator. No strategy / no isDummy: treat as off.
  signalkSecurityEnabled () {
    const s = this.app && this.app.securityStrategy
    try {
      return Boolean(s && typeof s.isDummy === 'function' && s.isDummy() === false)
    } catch (e) {
      return false
    }
  }

  // A SignalK admin session (only meaningful with SignalK security on).
  signalkAdmin (req) {
    if (!this.signalkSecurityEnabled()) return false
    const s = this.app.securityStrategy
    try {
      if (typeof s.allowConfigure === 'function') return Boolean(s.allowConfigure(req))
    } catch (e) {
      return false
    }
    return Boolean(req && req.skIsAuthenticated && req.skPrincipal && req.skPrincipal.permissions === 'admin')
  }

  // #23: who may call POST /devices/register for `id`. A new id can be paired
  // with an operator/provisioning credential; an EXISTING display only with
  // its own token. Re-keying a display is an explicit operator Re-claim
  // (reclaimDevice), never a side effect of re-registering, so the API token
  // (or a provisioning token) can never become -- or lock out -- a display.
  registrationPrincipal (id, auth) {
    if (this.isDevAuthMode() || !this.store.registry.devices[id]) {
      return this.requireDeviceAuth(id, auth, true)
    }
    try {
      return this.requireDeviceAuth(id, auth, false)
    } catch (err) {
      if (this.verifyOperatorCredential(auth) || this.verifyStaticProvisionToken(auth)) {
        throw httpError(409, 'reclaim_required',
          'this display is already paired; re-key it with Re-claim in the manager UI')
      }
      throw err
    }
  }

  // Authenticate a device->manager call. Returns the principal:
  //   { kind: 'device', trusted: true }        the device's own token
  //   { kind: 'legacy-device', trusted: false } the shared dev token a device
  //                                             paired before #23 still holds
  //   { kind: 'operator' | 'provision', trusted: false } (provisioningAllowed
  //                                             only: pairing a device)
  //   { kind: 'dev' | 'open', trusted: true }  explicit dev auth modes only
  // `trusted` = the caller is known to be that device.
  requireDeviceAuth (id, auth, provisioningAllowed) {
    auth = auth || {}
    if (this.options.auth.mode === 'disabled') return { kind: 'open', trusted: true }
    if (this.options.auth.mode === 'dev-shared-token') {
      if (auth.bearer === this.options.auth.devToken) return { kind: 'dev', trusted: true }
      if (provisioningAllowed && auth.provision === this.options.auth.devToken) return { kind: 'dev', trusted: true }
      throw httpError(401, 'unauthorized', 'invalid development token')
    }
    const device = this.store.registry.devices[id]
    if (device && auth.bearer) {
      const match = this.verifyDeviceToken(device, auth.bearer)
      if (match === 'device') return { kind: 'device', trusted: true }
      if (match === 'legacy') {
        this.onLegacyDeviceAuth(id)
        return { kind: 'legacy-device', trusted: false }
      }
    }
    if (provisioningAllowed) {
      if (this.verifyOperatorCredential(auth)) return { kind: 'operator', trusted: false }
      const provision = auth.provision || auth.bearer
      if (provision && this.consumeProvisioningToken(provision)) return { kind: 'provision', trusted: false }
      if (this.verifyStaticProvisionToken(auth)) return { kind: 'provision', trusted: false }
    }
    throw httpError(401, 'unauthorized', 'invalid device token')
  }

  // The manager API token (operator/provisioning credential), as either
  // `Bearer <token>` or `YeyBoats-Provision <token>`.
  verifyOperatorCredential (auth) {
    if (!auth || !this.apiToken) return false
    return [auth.provision, auth.bearer].some((t) => t && this.apiToken.verify(t))
  }

  // An operator-configured static provisioning token (never the old public default).
  verifyStaticProvisionToken (auth) {
    const configured = this.options.auth.provisionToken
    if (!configured || !auth) return false
    return [auth.provision, auth.bearer].some((t) => t && timingSafeEqual(hashToken(t), hashToken(configured)))
  }

  // 'device' for the device's own token, 'legacy' for the shared dev token it
  // still holds while its per-device token is being delivered, else false.
  verifyDeviceToken (device, token) {
    if (!device || !token) return false
    const hashed = hashToken(token)
    if (device.deviceTokenHash && timingSafeEqual(device.deviceTokenHash, hashed)) {
      this.onDeviceTokenSeen(device)
      return 'device'
    }
    if (device.pendingTokenHash && timingSafeEqual(device.pendingTokenHash, hashed)) {
      this.promotePendingToken(device)
      return 'device'
    }
    if (device.legacyTokenHash && timingSafeEqual(device.legacyTokenHash, hashed)) return 'legacy'
    if (device.deviceToken && timingSafeEqual(hashToken(device.deviceToken), hashed)) {
      device.deviceTokenHash = hashToken(device.deviceToken)
      delete device.deviceToken
      this.store.saveRegistry()
      return 'device'
    }
    return false
  }

  setDeviceToken (device, token) {
    device.deviceTokenHash = hashToken(token)
    device.deviceTokenId = randomId('tok')
    delete device.deviceToken
    delete device.legacyTokenHash
    delete device.pendingTokenHash
    delete device.tokenDelivery
    if (device.tokenMigration && device.tokenMigration.state !== 'done') {
      device.tokenMigration = { ...device.tokenMigration, state: 'done', doneAt: now() }
    }
    if (device.id && this.secrets) this.secrets.clearPendingManagerToken(device.id)
  }

  // A Re-claimed display used its new token: it becomes the only token.
  promotePendingToken (device) {
    device.deviceTokenHash = device.pendingTokenHash
    device.deviceTokenId = randomId('tok')
    delete device.pendingTokenHash
    delete device.deviceToken
    delete device.legacyTokenHash
    delete device.tokenDelivery
    device.reclaim = { ...(device.reclaim || {}), state: 'done', doneAt: now() }
    this.secrets.clearPendingManagerToken(device.id)
    this.store.saveRegistry()
    this.store.audit('device.token.reclaimed', device.id)
  }

  // First authentication with a delivered token: retire the shared token and
  // forget the plaintext.
  onDeviceTokenSeen (device) {
    // A Re-claim collecting its new token: the current token stays valid.
    if (device.pendingTokenHash) return
    if (!device.legacyTokenHash && !device.tokenDelivery &&
        !(this.secrets && this.secrets.pendingManagerToken(device.id))) return
    delete device.legacyTokenHash
    delete device.tokenDelivery
    if (device.tokenMigration && device.tokenMigration.state !== 'done') {
      device.tokenMigration = { ...device.tokenMigration, state: 'done', doneAt: now() }
      this.store.audit('device.token.migrated', device.id)
    }
    if (device.reclaim && device.reclaim.state !== 'done') {
      device.reclaim = { ...device.reclaim, state: 'done', doneAt: now() }
    }
    this.secrets.clearPendingManagerToken(device.id)
    this.store.saveRegistry()
  }

  // #23 migration: devices paired in dev-shared-token mode all hold the same
  // public token, and anyone holding it could have set the address the
  // manager has on file. So nothing is sent anywhere on start: each such
  // display is marked "needs re-claim" (the shared token keeps it online,
  // restricted: no address change, redacted config). The operator confirms
  // its address in the UI (reclaimDevice) before the manager pushes it its
  // credentials and own token.
  markLegacyDeviceTokens () {
    if (this.isDevAuthMode()) return
    const legacyHashes = new Set([hashToken(LEGACY_DEV_TOKEN), hashToken(this.options.auth.devToken)])
    let changed = false
    for (const device of Object.values(this.store.registry.devices)) {
      if (device.legacyTokenHash) continue
      const currentHash = device.deviceTokenHash || (device.deviceToken ? hashToken(device.deviceToken) : null)
      if (!currentHash) continue
      if (device.deviceTokenId !== 'dev' && !legacyHashes.has(currentHash)) continue
      device.legacyTokenHash = currentHash
      device.deviceTokenHash = null
      device.deviceTokenId = null
      delete device.deviceToken
      delete device.tokenDelivery
      device.tokenMigration = { state: 'needs-reclaim', since: now() }
      this.secrets.clearPendingManagerToken(device.id)
      this.store.audit('device.token.needs-reclaim', device.id)
      changed = true
    }
    if (changed) this.store.saveRegistry()
  }

  // Retry token deliveries that are waiting (claims, confirmed re-claims).
  // Never runs on its own at start; each delivery only goes to the address
  // the operator claimed / confirmed.
  async pushPendingManagerTokens () {
    const ids = Object.keys(this.store.registry.devices)
      .filter((id) => this.secrets.pendingManagerToken(id))
    for (const id of ids) {
      const device = this.store.registry.devices[id]
      if (!device || device.pendingTokenHash) continue
      if (device.tokenDelivery && device.tokenDelivery.state === 'delivered') continue
      await this.pushDeviceManagerToken(id).catch(() => {})
    }
  }

  // ---- Re-claim (#23) ---------------------------------------------------
  //
  // The only way to re-key a paired display. The display has to prove itself:
  //   - it still holds its own token: the new token is handed to it on its
  //     next registration made WITH that token (the heartbeat asks it to
  //     re-register); the current token stays valid until the new one is
  //     used, so nobody can lock the display out;
  //   - it has no usable token (paired with the old shared token, or
  //     revoked): the operator confirms the display's address, and the
  //     manager pushes the token there over the display's own Basic-Auth web
  //     API.
  //   - #25: it can show a one-time pairing code on its screen (firmware
  //     advertises `capabilities.pairingCode`): the operator, standing at
  //     the display, enters the code and confirms the address; the token is
  //     sent there with the code (the display's pairing endpoint checks it).
  //     The current-token path is not offered for such a display, so a
  //     stolen token cannot collect a new one.
  // One Re-claim at a time: while a current-token Re-claim is pending no
  // other token is minted; the operator cancels it first (cancelReclaim).
  reclaimDevice (id, body) {
    body = body || {}
    const device = this.getDevice(id)
    const code = this.checkPairingProof(body, device)
    if (this.isDevAuthMode()) return this.rotateDeviceTokenDev(device)
    if (device.pendingTokenHash) {
      throw httpError(409, 'reclaim_pending',
        `a Re-claim of this display is already ${(device.reclaim && device.reclaim.state) || 'pending'}; cancel it first (or Revoke the token if it may be stolen)`)
    }
    if (!code && device.deviceTokenHash && !device.legacyTokenHash) {
      const token = generateDeviceToken()
      device.pendingTokenHash = hashToken(token)
      this.secrets.setPendingManagerToken(id, token)
      delete device.tokenDelivery
      device.reclaim = { state: 'pending', method: 'device-token', requestedAt: now() }
      device.updatedAt = now()
      this.store.saveRegistry()
      this.store.audit('device.reclaim.requested', id, { method: 'device-token' })
      return {
        deviceId: id,
        status: 'pending',
        method: 'device-token',
        message: 'The display collects its new token (once) on its next heartbeat; its current token keeps working until then. If the token may be stolen, Revoke it and confirm the address instead.'
      }
    }
    const target = parseHostPort(body.confirmAddress, this.deviceHttpPort(device))
    if (!target) {
      const known = this.reclaimTarget(device)
      throw httpError(409, 'confirm_address_required',
        `confirm the display's address${known ? ` (on file: ${known.host}:${known.port})` : ''} before the manager sends it credentials`)
    }
    const method = code ? 'pairing-code' : 'confirmed-address'
    const token = generateDeviceToken()
    device.deviceTokenHash = hashToken(token)
    device.deviceTokenId = randomId('tok')
    delete device.pendingTokenHash
    delete device.deviceToken
    this.secrets.setPendingManagerToken(id, token)
    if (code) this._pairingCodes.set(id, code)
    else this._pairingCodes.delete(id)
    const address = `${target.host}:${target.port}`
    device.tokenDelivery = { state: 'pending', since: now(), attempts: 0, target, method }
    device.reclaim = { state: 'pending', method, address, requestedAt: now() }
    if (device.tokenMigration && device.tokenMigration.state !== 'done') {
      device.tokenMigration = { ...device.tokenMigration, state: 'confirmed', confirmedAt: now(), address }
    }
    device.updatedAt = now()
    this.store.saveRegistry()
    this.store.audit('device.reclaim.confirmed', id, { method, address })
    return { deviceId: id, status: 'pending', method, address }
  }

  // #25: the operator cancels a pending Re-claim. A current-token Re-claim's
  // new token is forgotten (if it was collected, it never becomes valid) and
  // the current token keeps working. A confirmed-address / pairing-code
  // Re-claim not yet delivered leaves the display without a usable token: it
  // is back in the "to re-claim" list.
  cancelReclaim (id) {
    const device = this.getDevice(id)
    const rc = device.reclaim
    const undelivered = rc && rc.state === 'pending' && device.tokenDelivery && device.tokenDelivery.state !== 'delivered'
    if (!device.pendingTokenHash && !undelivered) {
      throw httpError(409, 'no_reclaim_pending', 'this display has no pending Re-claim')
    }
    if (device.pendingTokenHash) {
      delete device.pendingTokenHash
    } else {
      device.deviceTokenHash = null
      device.deviceTokenId = null
      delete device.tokenDelivery
    }
    this.secrets.clearPendingManagerToken(id)
    this._pairingCodes.delete(id)
    device.reclaim = { ...(rc || {}), state: 'cancelled', cancelledAt: now() }
    device.updatedAt = now()
    this.store.saveRegistry()
    this.store.audit('device.reclaim.cancelled', id, { method: (rc && rc.method) || null })
    return { deviceId: id, status: 'cancelled' }
  }

  // #25 / instruments#33: the one-time pairing code shown on the display.
  // Required for a display whose firmware advertises it; refused (never
  // silently ignored) for firmware that cannot show and check one.
  checkPairingProof (body, device) {
    const raw = body && (body.pairingCode || body.code)
    const code = raw ? String(raw).trim().replace(/[\s-]/g, '').toUpperCase() : ''
    const supported = this.deviceSupportsPairingCode(device)
    if (code && !supported) {
      throw httpError(501, 'pairing_code_unsupported',
        'pairing codes need display firmware support that is not available yet')
    }
    if (supported && !this.isDevAuthMode()) {
      if (!code) {
        throw httpError(409, 'pairing_code_required',
          'enter the pairing code shown on the display\'s screen to re-claim it')
      }
      if (!/^[A-Z0-9]{4,16}$/.test(code)) throw httpError(400, 'invalid_pairing_code', 'the pairing code is 4-16 letters/digits')
    }
    return code || null
  }

  deviceSupportsPairingCode (device) {
    if (device && device.pairingCodeRequired) return true
    const caps = (device && device.capabilities) || {}
    return caps.pairingCode === true || caps.pairing_code === true
  }

  // PR #28 review: the sticky pairing-code requirement is cleared only here
  // (operator route), e.g. after flashing firmware without the screen code.
  clearPairingCodeRequirement (id) {
    const device = this.getDevice(id)
    delete device.pairingCodeRequired
    const caps = { ...(device.capabilities || {}) }
    delete caps.pairingCode
    delete caps.pairing_code
    device.capabilities = caps
    device.updatedAt = now()
    this.store.saveRegistry()
    this.store.audit('device.pairing_code.cleared', id)
    return { deviceId: id, pairingCode: false }
  }

  // The address on file for a display, as shown to the operator to confirm.
  reclaimTarget (device) {
    return this.deviceDeliveryTargets(device)[0] || null
  }

  // Displays the operator has to re-claim: paired with the old shared token,
  // or with no usable token. Address and last-seen info for the confirmation.
  reclaimCandidates () {
    return Object.values(this.store.registry.devices)
      .filter((d) => d.legacyTokenHash || !deviceHasToken(d))
      .map((d) => {
        const target = this.reclaimTarget(d)
        return {
          id: d.id,
          name: d.name || d.id,
          reason: d.legacyTokenHash ? 'shared-dev-token' : 'no-token',
          pairingCode: this.deviceSupportsPairingCode(d),
          state: (d.reclaim && d.reclaim.state) || (d.tokenMigration && d.tokenMigration.state) || 'needs-reclaim',
          address: target ? `${target.host}:${target.port}` : null,
          hostnames: [d.networkIdentity && d.networkIdentity.currentFqdn, d.networkIdentity && d.networkIdentity.desiredFqdn].filter(Boolean),
          lastSeen: d.lastSeen || null,
          firmware: d.firmware || null,
          delivery: d.tokenDelivery ? { state: d.tokenDelivery.state, lastError: d.tokenDelivery.lastError || null } : null
        }
      })
  }

  onLegacyDeviceAuth (id) {
    const device = this.store.registry.devices[id]
    if (!device || !this.secrets.pendingManagerToken(id)) return
    const d = device.tokenDelivery || {}
    // Only a delivery the operator confirmed (re-claim) is retried.
    if (!d.target) return
    if (d.state === 'delivered' || this._tokenPushes.has(id)) return
    const last = d.lastAttemptAt ? Date.parse(d.lastAttemptAt) : 0
    if (Date.now() - last < TOKEN_PUSH_RETRY_MS) return
    this.pushDeviceManagerToken(id).catch(() => {})
  }

  // Deliver a device its pending per-device manager token with the display's
  // `manager-token <token>` console command over its web API (POST /api/cmd,
  // the device's own Basic Auth). Only addresses the manager already holds for
  // the device are used, never the address of whoever is calling. In-flight
  // pushes are shared.
  pushDeviceManagerToken (id) {
    const inflight = this._tokenPushes.get(id)
    if (inflight) return inflight
    const p = this._pushDeviceManagerToken(id).finally(() => this._tokenPushes.delete(id))
    this._tokenPushes.set(id, p)
    return p
  }

  async _pushDeviceManagerToken (id) {
    const device = this.getDevice(id)
    const token = this.secrets.pendingManagerToken(id)
    if (!token) return { status: 'skipped', reason: 'no token awaiting delivery' }
    // A device-token Re-claim is collected by the display itself.
    if (device.pendingTokenHash) return { status: 'skipped', reason: 'the display collects it with its current token' }
    if (device.tokenDelivery && device.tokenDelivery.method === 'pairing-code') return this._pushPairingToken(device, token)
    const delivery = { ...(device.tokenDelivery || {}), state: 'pending' }
    delivery.attempts = Number(delivery.attempts || 0) + 1
    delivery.lastAttemptAt = now()
    device.tokenDelivery = delivery
    let lastError = null
    const confirmed = device.tokenDelivery && device.tokenDelivery.target
    const targets = confirmed ? [confirmed] : this.deviceDeliveryTargets(device)
    for (const target of targets) {
      try {
        await withAuthRetry(this.deviceDeliveryAuthCandidates(device),
          (auth) => this._postDeviceCommand(target.host, target.port, `manager-token ${token}`, auth))
        const current = this.store.registry.devices[id]
        if (current) {
          current.tokenDelivery = { ...delivery, state: 'delivered', deliveredAt: now(), lastError: null }
          this.store.saveRegistry()
        }
        this.store.audit('device.token.delivered', id)
        return { status: 'delivered' }
      } catch (err) {
        lastError = err
      }
    }
    const current = this.store.registry.devices[id]
    const message = lastError ? (lastError.code || lastError.message || 'unreachable') : 'device address is unknown'
    if (current) {
      current.tokenDelivery = { ...delivery, state: 'failed', lastError: String(message).slice(0, 200) }
      this.store.saveRegistry()
    }
    return { status: 'failed', error: String(message).slice(0, 200) }
  }

  _postDeviceCommand (host, port, line, auth) {
    return postDeviceCommand(host, port, line, auth)
  }

  // #25: deliver a pairing-code Re-claim to the confirmed address's pairing
  // endpoint (instruments#33: {code, manager_token, web_password}, accepted
  // once). The code lives in memory only and is used for one answer.
  async _pushPairingToken (device, token) {
    const id = device.id
    const delivery = { ...(device.tokenDelivery || {}), state: 'pending' }
    delivery.attempts = Number(delivery.attempts || 0) + 1
    delivery.lastAttemptAt = now()
    device.tokenDelivery = delivery
    const code = this._pairingCodes.get(id)
    const fail = (message) => {
      const current = this.store.registry.devices[id]
      if (current) {
        current.tokenDelivery = { ...delivery, state: 'failed', lastError: String(message).slice(0, 200) }
        this.store.saveRegistry()
      }
      return { status: 'failed', error: String(message).slice(0, 200) }
    }
    if (!code) return fail('pairing code expired; re-claim with the code on the display')
    const web = this.secrets.web(id)
    const body = { code, manager_token: token }
    if (web && web.password) body.web_password = web.password
    try {
      await this._postDevicePairing(delivery.target.host, delivery.target.port, body)
    } catch (err) {
      // The display answered: the code is spent (right or wrong).
      if (err && err.payload && err.payload.error && err.payload.error.code === 'device_http_error') this._pairingCodes.delete(id)
      return fail(err.code || err.message || 'unreachable')
    }
    this._pairingCodes.delete(id)
    const current = this.store.registry.devices[id]
    if (current) {
      current.tokenDelivery = { ...delivery, state: 'delivered', deliveredAt: now(), lastError: null }
      this.store.saveRegistry()
    }
    this.store.audit('device.token.delivered', id, { method: 'pairing-code' })
    return { status: 'delivered' }
  }

  _postDevicePairing (host, port, body) {
    return postDeviceRequest(host, port, '/api/pair', JSON.stringify(body), 'application/json', null)
  }

  // Where to deliver a token: addresses the device reported while
  // authenticated, then its discovery address, then its mDNS names.
  deviceDeliveryTargets (device) {
    const ni = device.networkIdentity || {}
    const disc = device.discovery || {}
    const port = this.deviceHttpPort(device)
    const raw = [
      [device.status && device.status.network && device.status.network.ip, port],
      [ni.lastResolvedAddress, port],
      [disc.address, Number(disc.port || port)],
      [ni.currentFqdn, port],
      [ni.desiredFqdn, port]
    ]
    const seen = new Set()
    const out = []
    for (const [host, p] of raw) {
      if (!host) continue
      const key = `${host}:${p}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ host, port: p })
    }
    return out
  }

  // The device's own credentials; a never-verified pairing also tries setup
  // open and the old shared password a fresh/old firmware may still enforce.
  deviceDeliveryAuthCandidates (device) {
    const out = this.deviceWebAuthCandidates(device)
    const web = this.secrets.web(device.id)
    if (!web || web.state !== 'verified') {
      const base = { enabled: this.options.deviceWebAuth.enabled, username: this.options.deviceWebAuth.username }
      for (const password of [null, this.options.deviceWebAuth.legacyPassword]) {
        if (!out.some((a) => a && a.password === password)) out.push({ ...base, password })
      }
    }
    return out
  }

  // GET /devices/:id/config. Secrets (webAuth.password, OTA password) only go
  // to the device's own credential; the manager API token and a legacy shared
  // token get a redacted copy with its own hash.
  deviceConfigFor (id, auth) {
    let principal
    try {
      principal = this.requireDeviceAuth(id, auth)
    } catch (err) {
      if (!this.isDevAuthMode() && this.store.registry.devices[id] && this.verifyOperatorCredential(auth)) {
        principal = { kind: 'operator', trusted: false }
      } else {
        throw err
      }
    }
    const config = this.generateConfig(id)
    return principal.trusted ? config : redactDeviceConfig(config)
  }

  consumeProvisioningToken (token) {
    const nowMs = Date.now()
    const record = this.store.provisioning.tokens.find((item) => {
      return verifyStoredToken(item, token) &&
        item.usesRemaining > 0 &&
        Date.parse(item.expiresAt) > nowMs
    })
    if (!record) return false
    if (record.token) {
      record.tokenHash = hashToken(record.token)
      delete record.token
    }
    record.usesRemaining -= 1
    this.store.saveProvisioning()
    this.store.audit('provisioning.token.used', record.id, { usesRemaining: record.usesRemaining })
    return true
  }
}

function normalizeOptions (options) {
  return {
    serverId: options.serverId || 'yey-boats-display-manager',
    heartbeatMs: Math.max(Number(options.heartbeatMs || 30000), 30000),
    commandPollMs: Math.max(Number(options.commandPollMs || 15000), 15000),
    auth: normalizeAuthOptions(options.auth || {}),
    signalk: {
      host: options.signalk && options.signalk.host ? options.signalk.host : 'signalk.local',
      port: Number(options.signalk && options.signalk.port ? options.signalk.port : 3000)
    },
    // Control protocol (yeyboats control-2): how this plugin presents itself
    // when it attaches to a target as a controller (the colored "controlled"
    // frame on the display). `enabled` routes screen.set through the protocol
    // when the device speaks it; the registry/command-queue path remains as a
    // fallback for devices that do not.
    control: {
      enabled: !(options.control && options.control.enabled === false),
      controllerId: options.control && options.control.controllerId
        ? options.control.controllerId
        : 'plugin:yey-boats-display-manager',
      name: options.control && options.control.name ? options.control.name : 'SignalK Manager',
      color: options.control && options.control.color ? options.control.color : '#ff9800',
      key: options.control && options.control.key ? options.control.key : ''
    },
    deviceWebAuth: {
      enabled: !(options.deviceWebAuth && options.deviceWebAuth.enabled === false),
      username: options.deviceWebAuth && options.deviceWebAuth.username ? options.deviceWebAuth.username : 'yeyboats',
      // Passwords are per device (lib/device-secrets.js). A shared password
      // from a pre-#19 saved config is only used to reach + migrate devices
      // that still enforce it; it is never pushed.
      legacyPassword: options.deviceWebAuth && options.deviceWebAuth.password
        ? options.deviceWebAuth.password
        : LEGACY_SHARED_WEB_PASSWORD
    },
    discoveryUdp: {
      enabled: !(options.discoveryUdp && options.discoveryUdp.enabled === false),
      bind: options.discoveryUdp && options.discoveryUdp.bind ? options.discoveryUdp.bind : '0.0.0.0',
      port: Number(options.discoveryUdp && Object.prototype.hasOwnProperty.call(options.discoveryUdp, 'port') ? options.discoveryUdp.port : 34300),
      host: options.discoveryUdp && options.discoveryUdp.host ? options.discoveryUdp.host : ''
    },
    deviceDiscoveryUdp: {
      enabled: !(options.deviceDiscoveryUdp && options.deviceDiscoveryUdp.enabled === false),
      bind: options.deviceDiscoveryUdp && options.deviceDiscoveryUdp.bind ? options.deviceDiscoveryUdp.bind : '0.0.0.0',
      port: Number(options.deviceDiscoveryUdp && Object.prototype.hasOwnProperty.call(options.deviceDiscoveryUdp, 'port') ? options.deviceDiscoveryUdp.port : 34301)
    },
    firmware: {
      github: {
        enabled: !(options.firmware && options.firmware.github && options.firmware.github.enabled === false),
        owner: options.firmware && options.firmware.github && options.firmware.github.owner ? options.firmware.github.owner : 'yey-boats',
        repo: options.firmware && options.firmware.github && options.firmware.github.repo ? options.firmware.github.repo : 'instruments',
        apiBase: options.firmware && options.firmware.github && options.firmware.github.apiBase ? options.firmware.github.apiBase : 'https://api.github.com',
        includePrereleases: Boolean(options.firmware && options.firmware.github && options.firmware.github.includePrereleases),
        tipFromArtifacts: !(options.firmware && options.firmware.github && options.firmware.github.tipFromArtifacts === false),
        token: options.firmware && options.firmware.github && options.firmware.github.token ? String(options.firmware.github.token) : '',
        targets: options.firmware && options.firmware.github && Array.isArray(options.firmware.github.targets) ? options.firmware.github.targets : SUPPORTED_FIRMWARE_TARGETS,
        fetch: options.firmware && options.firmware.github && options.firmware.github.fetch
      }
    },
    network: {
      domain: options.network && options.network.domain ? options.network.domain : 'yey.boats',
      hostnamePrefix: options.network && options.network.hostnamePrefix ? options.network.hostnamePrefix : 'yey-d',
      namingPolicy: options.network && options.network.namingPolicy ? options.network.namingPolicy : 'device-id',
      mdns: {
        enabled: !(options.network && options.network.mdns && options.network.mdns.enabled === false),
        browser: !(options.network && options.network.mdns && options.network.mdns.browser === false),
        advertiseManager: !(options.network && options.network.mdns && options.network.mdns.advertiseManager === false),
        bind: options.network && options.network.mdns && options.network.mdns.bind ? options.network.mdns.bind : '0.0.0.0',
        port: Number(options.network && options.network.mdns && Object.prototype.hasOwnProperty.call(options.network.mdns, 'port') ? options.network.mdns.port : MDNS_PORT),
        advertiseHost: options.network && options.network.mdns && options.network.mdns.advertiseHost ? options.network.mdns.advertiseHost : '',
        advertiseIntervalMs: Number(options.network && options.network.mdns && options.network.mdns.advertiseIntervalMs ? options.network.mdns.advertiseIntervalMs : 60000)
      }
    }
  }
}

async function fetchGithubRelease (cfg, doFetch) {
  const base = String(cfg.apiBase || 'https://api.github.com').replace(/\/$/, '')
  const path = cfg.includePrereleases
    ? `/repos/${cfg.owner}/${cfg.repo}/releases`
    : `/repos/${cfg.owner}/${cfg.repo}/releases/latest`
  const payload = await fetchJson(`${base}${path}`, doFetch)
  if (Array.isArray(payload)) {
    const release = payload.find((candidate) => !candidate.draft)
    if (!release) throw httpError(404, 'github_release_not_found', 'no GitHub release found')
    return release
  }
  return payload
}

// Classify a GitHub release into the source-kind the flash UI filters on.
// The rolling main build is tagged `tip`; tagged builds flagged prerelease
// (-rc / -alpha / -beta) are 'prerelease'; everything else is 'release'.
function firmwareSourceKind (tag, prerelease) {
  if (String(tag).toLowerCase() === 'tip') return 'tip'
  return prerelease ? 'prerelease' : 'release'
}

// Gather the releases to import: the base release (latest stable, or the
// full list when includePrereleases is on) PLUS the rolling `tip`
// prerelease, fetched explicitly so it is always listed. De-duplicated by
// tag; draft releases are skipped. Fetching `tip` is best-effort — if the
// repo has no `tip` release yet we just omit it rather than fail the refresh.
async function collectGithubReleases (cfg, doFetch) {
  const base = String(cfg.apiBase || 'https://api.github.com').replace(/\/$/, '')
  const byTag = new Map()
  const add = (release) => {
    if (!release || release.draft) return
    const tag = release.tag_name || release.name
    if (!tag || byTag.has(tag)) return
    byTag.set(tag, release)
  }

  if (cfg.includePrereleases) {
    const list = await fetchJson(`${base}/repos/${cfg.owner}/${cfg.repo}/releases`, doFetch)
    if (Array.isArray(list)) list.forEach(add)
    else add(list)
  } else {
    const latest = await fetchJson(`${base}/repos/${cfg.owner}/${cfg.repo}/releases/latest`, doFetch)
    if (Array.isArray(latest)) latest.forEach(add)
    else add(latest)
  }

  // Always try to include the rolling `tip` build, even with prereleases off.
  if (!byTag.has('tip')) {
    try {
      const tip = await fetchJson(`${base}/repos/${cfg.owner}/${cfg.repo}/releases/tags/tip`, doFetch)
      add(tip)
    } catch (err) {
      // No `tip` release published yet — fine, just skip it.
    }
  }

  return Array.from(byTag.values())
}

async function fetchJson (url, doFetch, extraHeaders) {
  const response = await doFetch(url, {
    headers: { Accept: 'application/vnd.github+json', ...(extraHeaders || {}) }
  })
  if (!response || !response.ok) {
    throw httpError(502, 'github_request_failed', `GitHub request failed: ${url}`)
  }
  return response.json()
}

// Auth + API-version headers for the GitHub REST API. Used for the Actions
// runs/artifacts/contents calls (the TIP-from-artifacts source). Downloading
// Actions artifacts requires auth even for public repos.
function githubAuthHeaders (token) {
  return {
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28'
  }
}

// Download a GitHub Actions artifact ZIP. The archive_download_url requires
// the Authorization header, and GitHub responds with a 302 redirect to a
// signed blob storage URL that must NOT receive the Authorization header
// (sending it can be rejected by the storage backend). We therefore disable
// automatic redirect-following where the runtime supports it and re-issue the
// redirect target unauthenticated; if the fetch impl follows redirects
// transparently (carrying no auth to the final hop by default), the single
// authenticated call still works.
async function fetchActionsArtifactZip (url, token, doFetch) {
  const headers = githubAuthHeaders(token)
  let response
  try {
    response = await doFetch(url, { headers, redirect: 'manual' })
  } catch (err) {
    // Some fetch impls don't accept redirect:'manual' — fall back to default.
    response = await doFetch(url, { headers })
  }
  if (!response) throw httpError(502, 'artifact_download_failed', `failed to download Actions artifact: ${url}`)
  const status = Number(response.status || 0)
  if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
    const location = response.headers && typeof response.headers.get === 'function' ? response.headers.get('location') : null
    if (!location) throw httpError(502, 'artifact_download_failed', 'Actions artifact redirect missing Location header')
    // Signed storage URL — do NOT forward the Authorization header.
    const signed = await doFetch(location)
    if (!signed || !signed.ok) throw httpError(502, 'artifact_download_failed', `failed to download signed Actions artifact: ${location}`)
    return Buffer.from(await signed.arrayBuffer())
  }
  if (!response.ok) throw httpError(502, 'artifact_download_failed', `failed to download Actions artifact (${status}): ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

// Dependency-free ZIP reader: locate the entry whose name ends with
// `merged_firmware.bin` and return its decompressed bytes. Parses the
// End-Of-Central-Directory record + central directory (rather than streaming
// local headers) so we get authoritative compressed/uncompressed sizes and
// avoid the data-descriptor ambiguity that GitHub's artifact zips can use.
// Supports method 0 (stored) and method 8 (raw deflate via zlib).
function extractMergedFirmwareFromZip (zipBuf) {
  if (!Buffer.isBuffer(zipBuf) || zipBuf.length < 22) return null
  const EOCD_SIG = 0x06054b50
  const CDH_SIG = 0x02014b50
  const LFH_SIG = 0x04034b50

  // Find End-Of-Central-Directory by scanning backwards (it has a trailing
  // variable-length comment, so it isn't always at a fixed offset).
  let eocd = -1
  const minStart = Math.max(0, zipBuf.length - 22 - 0xffff)
  for (let i = zipBuf.length - 22; i >= minStart; i--) {
    if (zipBuf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) return null
  const cdEntries = zipBuf.readUInt16LE(eocd + 10)
  let cdOffset = zipBuf.readUInt32LE(eocd + 16)
  if (cdOffset >= zipBuf.length) return null

  let ptr = cdOffset
  for (let n = 0; n < cdEntries; n++) {
    if (ptr + 46 > zipBuf.length || zipBuf.readUInt32LE(ptr) !== CDH_SIG) break
    const method = zipBuf.readUInt16LE(ptr + 10)
    const compSize = zipBuf.readUInt32LE(ptr + 20)
    const nameLen = zipBuf.readUInt16LE(ptr + 28)
    const extraLen = zipBuf.readUInt16LE(ptr + 30)
    const commentLen = zipBuf.readUInt16LE(ptr + 32)
    const lhOffset = zipBuf.readUInt32LE(ptr + 42)
    const name = zipBuf.toString('utf8', ptr + 46, ptr + 46 + nameLen)
    ptr += 46 + nameLen + extraLen + commentLen

    if (!name.endsWith('merged_firmware.bin')) continue

    // Read the matching local file header to find where the data starts
    // (the local header's name/extra lengths can differ from the central
    // directory's, so we must read them from the local header itself).
    if (lhOffset + 30 > zipBuf.length || zipBuf.readUInt32LE(lhOffset) !== LFH_SIG) return null
    const lhNameLen = zipBuf.readUInt16LE(lhOffset + 26)
    const lhExtraLen = zipBuf.readUInt16LE(lhOffset + 28)
    const dataStart = lhOffset + 30 + lhNameLen + lhExtraLen
    const dataEnd = dataStart + compSize
    if (dataEnd > zipBuf.length) return null
    const comp = zipBuf.subarray(dataStart, dataEnd)
    if (method === 0) return Buffer.from(comp)
    if (method === 8) return zlib.inflateRawSync(comp)
    return null
  }
  return null
}

async function fetchText (url, doFetch) {
  const response = await doFetch(url)
  if (!response || !response.ok) {
    throw httpError(502, 'github_request_failed', `GitHub request failed: ${url}`)
  }
  return response.text()
}

function parseSha256Sums (text) {
  const sums = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+(.+)$/)
    if (!match) continue
    sums[match[2].replace(/^\.\//, '')] = match[1].toLowerCase()
  }
  return sums
}

function sanitizeArtifactId (value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '-')
}

function normalizeFirmwareTarget (entry) {
  if (entry && typeof entry === 'object') {
    const target = entry.target || entry.env || entry.id
    return { target, board: entry.board || boardIdFromReleaseTarget(target) }
  }
  return { target: entry, board: boardIdFromReleaseTarget(entry) }
}

function boardIdFromReleaseTarget (target) {
  const known = SUPPORTED_FIRMWARE_TARGETS.find((entry) => entry.target === target)
  if (known) return known.board
  return String(target || '').replace(/-/g, '_')
}

function firmwarePayloadSha256 (value) {
  const sha = String(value || '')
  return sha.startsWith('sha256:') ? sha.slice('sha256:'.length) : sha
}

function sha256OfFile (filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch (err) {
    return null
  }
}

function upsertFirmwareArtifact (artifacts, artifact) {
  const index = artifacts.findIndex((existing) => existing.artifactId === artifact.artifactId)
  if (index >= 0) {
    artifacts[index] = { ...artifacts[index], ...artifact }
  } else {
    artifacts.push(artifact)
  }
}

function devicesFromMdnsPacket (packet, rinfo) {
  const msg = parseMdnsPacket(packet)
  if (!msg) return []

  const serviceInstances = new Set()
  const instances = new Map()
  const addresses = new Map()
  for (const rr of msg.records) {
    const name = rr.name.toLowerCase()
    if (rr.type === 12 && name === YEYBOATS_MDNS_SERVICE) {
      serviceInstances.add(rr.ptr)
      if (!instances.has(rr.ptr)) instances.set(rr.ptr, { instance: rr.ptr })
    } else if (rr.type === 33) {
      const item = instances.get(rr.name) || { instance: rr.name }
      item.port = rr.port
      item.target = rr.target
      instances.set(rr.name, item)
    } else if (rr.type === 16) {
      const item = instances.get(rr.name) || { instance: rr.name }
      item.txt = { ...(item.txt || {}), ...rr.txt }
      instances.set(rr.name, item)
    } else if (rr.type === 1 && rr.address) {
      addresses.set(name, rr.address)
    }
  }

  const out = []
  for (const [instanceName, item] of instances.entries()) {
    const txt = item.txt || {}
    const isEspDisp = serviceInstances.has(instanceName) ||
      txt.proto === '1' ||
      instanceName.toLowerCase().endsWith(`.${YEYBOATS_MDNS_SERVICE}`)
    if (!isEspDisp) continue

    const id = sanitizeDeviceId(txt.device_id || txt.deviceId ||
      instanceName.split('.')[0])
    if (!id) continue

    const target = item.target || ''
    const address = target
      ? addresses.get(target.toLowerCase()) || null
      : null
    const display = parseDisplay(txt.display)
    const firmware = txt.firmware || txt.version
      ? { name: txt.firmware || 'yey-display', version: txt.version || null }
      : null
    const authRequired = txt.auth === 'basic'
    out.push({
      id,
      deviceId: id,
      name: id,
      source: 'mdns',
      address: address || (rinfo && rinfo.address) || null,
      port: Number(item.port || 80),
      transport: 'http',
      services: [{ type: '_yeyboats._tcp', port: Number(item.port || 80) }],
      mdns: {
        instance: instanceName,
        target: target || null,
        txt
      },
      board: txt.board || null,
      firmware,
      display,
      authRequired,
      capabilities: {}
    })
  }
  return out
}

function parseDisplay (value) {
  if (!value || typeof value !== 'string') return null
  const m = value.match(/^(\d+)x(\d+)$/)
  if (!m) return null
  return { width: Number(m[1]), height: Number(m[2]) }
}

function parseMdnsPacket (packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 12) return null
  const qd = packet.readUInt16BE(4)
  const an = packet.readUInt16BE(6)
  const ns = packet.readUInt16BE(8)
  const ar = packet.readUInt16BE(10)
  let off = 12
  const questions = []
  for (let i = 0; i < qd; i++) {
    const q = readDnsName(packet, off)
    if (!q) return null
    if (q.offset + 4 > packet.length) return null
    questions.push({
      name: q.name,
      type: packet.readUInt16BE(q.offset),
      class: packet.readUInt16BE(q.offset + 2)
    })
    off = q.offset + 4
    if (off > packet.length) return null
  }

  const records = []
  const count = an + ns + ar
  for (let i = 0; i < count; i++) {
    const n = readDnsName(packet, off)
    if (!n || n.offset + 10 > packet.length) return null
    off = n.offset
    const type = packet.readUInt16BE(off)
    const klass = packet.readUInt16BE(off + 2)
    const ttl = packet.readUInt32BE(off + 4)
    const rdlen = packet.readUInt16BE(off + 8)
    off += 10
    if (off + rdlen > packet.length) return null
    const rdata = off
    const end = off + rdlen
    const rr = { name: n.name, type, class: klass, ttl }
    if (type === 12) {
      const ptr = readDnsName(packet, rdata)
      if (ptr) rr.ptr = ptr.name
    } else if (type === 33 && rdlen >= 6) {
      rr.priority = packet.readUInt16BE(rdata)
      rr.weight = packet.readUInt16BE(rdata + 2)
      rr.port = packet.readUInt16BE(rdata + 4)
      const target = readDnsName(packet, rdata + 6)
      if (target) rr.target = target.name
    } else if (type === 16) {
      rr.txt = parseTxtRecord(packet.subarray(rdata, end))
    } else if (type === 1 && rdlen === 4) {
      rr.address = `${packet[rdata]}.${packet[rdata + 1]}.${packet[rdata + 2]}.${packet[rdata + 3]}`
    }
    records.push(rr)
    off = end
  }
  return { questions, records }
}

function mdnsPacketHasQuestion (packet, name) {
  const msg = parseMdnsPacket(packet)
  if (!msg) return false
  const want = name.toLowerCase()
  return msg.questions.some((q) => {
    const qname = q.name.toLowerCase()
    return qname === want || qname === YEYBOATS_MGMT_MDNS_SERVICE
  })
}

function buildManagerMdnsPacket (options, cfg) {
  const serverId = options.serverId || 'yey-boats-display-manager'
  const instance = `${serverId}.${YEYBOATS_MGMT_MDNS_SERVICE}`
  const targetHost = sanitizeMdnsHost(serverId)
  const target = `${targetHost}.local`
  const address = cfg.advertiseHost || firstLocalIpv4() || '127.0.0.1'
  const port = Number(options.signalk && options.signalk.port ? options.signalk.port : 3000)
  const txt = [
    'protocol=yeyboats.management.v2',
    'path=/plugins/yey-boats-display-manager',
    `server_id=${serverId}`,
    `auth=${options.auth && options.auth.mode ? options.auth.mode : 'dev-shared-token'}`,
    'tls=false',
    `signalk_port=${port}`,
    'nmea0183_tcp=10110'
  ]
  const answers = [
    dnsRecord(YEYBOATS_MGMT_MDNS_SERVICE, 12, dnsName(instance), 120),
    dnsRecord(instance, 33, Buffer.concat([
      Buffer.from([0, 0, 0, 0, (port >> 8) & 0xff, port & 0xff]),
      dnsName(target)
    ]), 120),
    dnsRecord(instance, 16, dnsTxt(txt), 120),
    dnsRecord(target, 1, ipv4Bytes(address), 120)
  ]
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0, 0)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(0, 4)
  header.writeUInt16BE(answers.length, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(0, 10)
  return Buffer.concat([header, ...answers])
}

function dnsRecord (name, type, rdata, ttl) {
  const head = Buffer.alloc(10)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(1, 2)
  head.writeUInt32BE(ttl, 4)
  head.writeUInt16BE(rdata.length, 8)
  return Buffer.concat([dnsName(name), head, rdata])
}

function dnsName (name) {
  const parts = name.split('.').filter(Boolean)
  return Buffer.concat([
    ...parts.map((part) => {
      const buf = Buffer.from(part)
      return Buffer.concat([Buffer.from([buf.length]), buf])
    }),
    Buffer.from([0])
  ])
}

function dnsTxt (items) {
  return Buffer.concat(items.map((item) => {
    const buf = Buffer.from(item)
    return Buffer.concat([Buffer.from([buf.length]), buf])
  }))
}

function ipv4Bytes (address) {
  const parts = String(address).split('.').map((v) => Number(v))
  if (parts.length !== 4 || parts.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
    return Buffer.from([127, 0, 0, 1])
  }
  return Buffer.from(parts)
}

function firstLocalIpv4 () {
  const nets = os.networkInterfaces()
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return ''
}

function sanitizeMdnsHost (value) {
  return String(value || 'yey-boats-display-manager')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'yey-boats-display-manager'
}

function readDnsName (packet, offset) {
  const labels = []
  let off = offset
  let jumped = false
  let next = offset
  let guard = 0
  for (;;) {
    if (off >= packet.length || ++guard > 64) return null
    const len = packet[off]
    if (len === 0) {
      off += 1
      if (!jumped) next = off
      return { name: labels.join('.'), offset: next }
    }
    if ((len & 0xc0) === 0xc0) {
      if (off + 1 >= packet.length) return null
      const ptr = ((len & 0x3f) << 8) | packet[off + 1]
      if (!jumped) next = off + 2
      off = ptr
      jumped = true
      continue
    }
    if ((len & 0xc0) !== 0 || off + 1 + len > packet.length) return null
    labels.push(packet.subarray(off + 1, off + 1 + len).toString('utf8'))
    off += 1 + len
    if (!jumped) next = off
  }
}

function parseTxtRecord (buf) {
  const txt = {}
  let off = 0
  while (off < buf.length) {
    const len = buf[off++]
    if (len === 0 || off + len > buf.length) break
    const item = buf.subarray(off, off + len).toString('utf8')
    off += len
    const eq = item.indexOf('=')
    if (eq < 0) {
      txt[item] = true
    } else {
      txt[item.slice(0, eq)] = item.slice(eq + 1)
    }
  }
  return txt
}

// #29: one entry per address an anonymous register came from. A record
// written before #29 has only its top-level address.
function anonymousSightings (record) {
  if (Array.isArray(record.sightings) && record.sightings.length) return record.sightings
  return record.address ? [sightingEntry(record, record)] : []
}

function sightingEntry (src, seen) {
  return {
    address: src.address,
    port: Number(src.port || 80),
    firstSeen: seen.firstSeen || null,
    lastSeen: seen.lastSeen || null,
    seenCount: Number(seen.seenCount || 1),
    name: src.name || null,
    capabilities: src.capabilities || {},
    firmware: src.firmware || null,
    board: src.board || null,
    display: src.display || null
  }
}

// #29: rate-limit/eviction key. An IPv6 host can use any address of its /64,
// so the /64 prefix is one bucket; IPv4 addresses are their own bucket.
function sightingBucket (address) {
  const a = String(address || '').toLowerCase().replace(/%.*$/, '')
  if (!a.includes(':')) return a
  const [head, tail = ''] = a.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = a.includes('::')
    ? [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
    : h
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64'
}

function discoveryAddressKey (device) {
  if (!device || !device.address) return ''
  return `${device.address}:${Number(device.port || 80)}`
}

function isStaleDiscovery (device, at) {
  const lastSeenMs = device && device.lastSeen ? Date.parse(device.lastSeen) : 0
  const atMs = Date.parse(at || now())
  return !lastSeenMs || !atMs || atMs - lastSeenMs > 60000
}

function normalizeDiscoveryBody (body) {
  body = body || {}
  const nested = body.device || {}
  return {
    ...nested,
    ...body,
    id: nested.id || body.id || body.deviceId,
    deviceId: body.deviceId || nested.deviceId || nested.id || body.id,
    name: body.name || nested.name || body.deviceId || nested.id,
    board: body.board || nested.board || nested.board_id || null,
    firmware: body.firmware || nested.firmware || null,
    display: body.display || nested.display || null,
    capabilities: body.capabilities || nested.capabilities || {},
    address: body.address || body.ip || nested.address || nested.ip || null,
    authRequired: Boolean(body.authRequired || nested.authRequired),
    port: body.port || nested.port || 80,
    services: body.services || nested.services || [],
    mdns: body.mdns || nested.mdns || null,
    transport: body.transport || nested.transport || 'http'
  }
}

// Run `fn(auth)` with each credential in turn; only an HTTP 401 moves on to
// the next one. Errors never include the credential.
async function withAuthRetry (auths, fn) {
  const list = Array.isArray(auths) && auths.length ? auths : [null]
  let lastErr
  for (const auth of list) {
    try {
      return await fn(auth)
    } catch (err) {
      lastErr = err
      if (err && err.status === 401) continue
      throw err
    }
  }
  throw lastErr
}

function basicAuthHeaders (auth) {
  if (auth && auth.enabled && auth.username && auth.password) {
    return { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` }
  }
  return {}
}

function httpGetJson (url, auth, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = basicAuthHeaders(auth)
    const req = http.get(url, { headers, timeout: timeoutMs || 3000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
        if (body.length > 128 * 1024) req.destroy(new Error('device response too large'))
      })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(httpError(res.statusCode, 'device_http_error', `device returned HTTP ${res.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(httpError(502, 'device_bad_json', 'device returned invalid JSON'))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('device request timeout')))
    req.on('error', (err) => reject(httpError(502, 'device_unreachable', err.message)))
  })
}

function postDeviceCommand (host, port, line, auth) {
  return postDeviceRequest(host, port, '/api/cmd', String(line || ''), 'text/plain', auth)
}

function postDeviceRequest (host, port, path, body, contentType, auth) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(body)
    }
    Object.assign(headers, basicAuthHeaders(auth))
    const req = http.request({
      host,
      port,
      path,
      method: 'POST',
      headers,
      timeout: 3000
    }, (res) => {
      let response = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        response += chunk
        if (response.length > 64 * 1024) req.destroy(new Error('device response too large'))
      })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(httpError(res.statusCode, 'device_http_error', `device returned HTTP ${res.statusCode}`))
          return
        }
        resolve({
          status: 'sent',
          httpStatus: res.statusCode,
          command: body,
          response
        })
      })
    })
    req.on('timeout', () => req.destroy(new Error('device request timeout')))
    req.on('error', (err) => reject(httpError(502, 'device_unreachable', err.message)))
    req.write(body)
    req.end()
  })
}

function discoveryDeviceFromState (state, host, port) {
  if (!state || !state.device || !state.device.id) return null
  if (!state.wifi && !state.manager && !state.screen) return null
  return {
    id: state.device.id,
    deviceId: state.device.id,
    name: state.device.name || state.device.id,
    source: 'ip-scan',
    address: host,
    port,
    transport: 'http',
    authRequired: Boolean(state.webAuth && state.webAuth.enabled),
    display: state.display
      ? {
          width: Number(state.display.width || state.display.w || 0) || undefined,
          height: Number(state.display.height || state.display.h || 0) || undefined,
          rotation: Number(state.display.rotation || 0) || 0,
          brightness: state.display.brightness
        }
      : null,
    firmware: state.device.build ? { build: state.device.build } : null,
    capabilities: {
      web: true,
      manager: Boolean(state.manager),
      touch: Boolean(state.touch)
    },
    services: [
      { type: '_yeyboats._tcp', port }
    ]
  }
}

function scanCandidates (value, store, limit) {
  const seen = new Set()
  const out = []
  const add = (host) => {
    host = String(host || '').trim()
    if (!isIpv4(host) || seen.has(host) || out.length >= limit) return
    seen.add(host)
    out.push(host)
  }
  const raw = Array.isArray(value) ? value.join(',') : String(value || '').trim()
  const tokens = raw
    ? raw.split(/[\s,]+/).filter(Boolean)
    : defaultScanTargets(store)
  tokens.forEach((token) => expandScanToken(token, add, limit))
  return out
}

function defaultScanTargets (store) {
  const targets = []
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family !== 'IPv4' || addr.internal || !isIpv4(addr.address)) continue
      const parts = addr.address.split('.')
      targets.push(`${parts[0]}.${parts[1]}.${parts[2]}.0/24`)
    }
  }
  for (const device of Object.values((store.discovery && store.discovery.devices) || {})) {
    if (device.address) targets.push(device.address)
  }
  for (const device of Object.values((store.registry && store.registry.devices) || {})) {
    const ip = device.discovery && device.discovery.address
      ? device.discovery.address
      : device.networkIdentity && device.networkIdentity.lastResolvedAddress
    if (ip) targets.push(ip)
  }
  return targets
}

function expandScanToken (token, add, limit) {
  if (token.includes('/')) {
    const [base, prefixRaw] = token.split('/')
    const prefix = Number(prefixRaw)
    if (!isIpv4(base) || !Number.isInteger(prefix) || prefix < 24 || prefix > 32) return
    const count = Math.min(2 ** (32 - prefix), limit)
    const start = ipv4ToInt(base) & (0xffffffff << (32 - prefix))
    for (let i = 1; i < count - 1; i++) add(intToIpv4(start + i))
    if (prefix === 32) add(base)
    return
  }
  if (token.includes('-')) {
    const [startRaw, endRaw] = token.split('-')
    if (!isIpv4(startRaw)) return
    const startParts = startRaw.split('.').map(Number)
    const end = isIpv4(endRaw)
      ? Number(endRaw.split('.')[3])
      : Number(endRaw)
    if (!Number.isInteger(end) || end < 0 || end > 255) return
    const lo = Math.min(startParts[3], end)
    const hi = Math.max(startParts[3], end)
    for (let last = lo; last <= hi; last++) {
      add(`${startParts[0]}.${startParts[1]}.${startParts[2]}.${last}`)
    }
    return
  }
  add(token)
}

function parseScanPorts (value) {
  const ports = (Array.isArray(value) ? value : String(value).split(/[\s,]+/))
    .map((port) => Number(port))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535)
  return ports.length ? Array.from(new Set(ports)).slice(0, 8) : [80]
}

async function mapLimit (items, limit, fn) {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = index++
      if (current >= items.length) return
      await fn(items[current])
    }
  })
  await Promise.all(workers)
}

function isIpv4 (value) {
  const parts = String(value || '').split('.')
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d+$/.test(part)) return false
    const n = Number(part)
    return n >= 0 && n <= 255
  })
}

function ipv4ToInt (ip) {
  return ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0)
}

function intToIpv4 (value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.')
}

function firmwareVersionFromDevice (device) {
  const firmware = device.firmware || {}
  const identity = device.identity || {}
  return firmware.version ||
    firmware.semver ||
    firmware.build ||
    identity.firmware_version ||
    identity.firmwareVersion ||
    (identity.firmware && identity.firmware.version) ||
    null
}

function compareFirmwareArtifacts (a, b) {
  const uploaded = String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || ''))
  if (uploaded !== 0) return uploaded
  const av = a.firmware && a.firmware.version ? String(a.firmware.version) : ''
  const bv = b.firmware && b.firmware.version ? String(b.firmware.version) : ''
  return bv.localeCompare(av, undefined, { numeric: true, sensitivity: 'base' })
}

function isDeviceOnline (device, heartbeatMs) {
  const lastSeenMs = device.lastSeen ? Date.parse(device.lastSeen) : 0
  if (!lastSeenMs) return false
  return Date.now() - lastSeenMs <= Math.max(Number(heartbeatMs || 0) * 3, 15000)
}

function summarizeDevice (device) {
  return {
    id: device.id,
    name: device.name,
    role: device.role,
    location: device.location,
    claimed: device.claimed,
    lastSeen: device.lastSeen,
    firmware: device.firmware,
    display: device.display,
    auth: device.auth
      ? {
          web: device.auth.web || null,
          manager: device.auth.manager || null
        }
      : null,
    discovery: device.discovery || null,
    networkIdentity: device.networkIdentity,
    assignedProfile: device.assignedProfile,
    config: device.config,
    status: device.status && device.status.network
      ? { network: device.status.network, ui: device.status.ui }
      : {}
  }
}

// #23: the shared dev token / disabled auth are only reachable with the
// explicit dev flag (options.auth.devAuth, set by the plugin from
// YEYBOATS_MANAGER_DEV_AUTH=1). Anything else runs the per-device token mode.
function normalizeAuthOptions (auth) {
  const requestedMode = auth.mode ? String(auth.mode) : 'device-token'
  const devAuth = auth.devAuth === true
  const mode = devAuth && DEV_AUTH_MODES.includes(requestedMode) ? requestedMode : 'device-token'
  const provisionToken = auth.provisionToken && auth.provisionToken !== LEGACY_DEFAULT_PROVISION_TOKEN
    ? String(auth.provisionToken)
    : ''
  return {
    mode,
    requestedMode,
    devAuth,
    devToken: auth.devToken ? String(auth.devToken) : LEGACY_DEV_TOKEN,
    provisionToken
  }
}

// >= 128 bits (24 bytes), URL/console safe, well within the firmware limits.
function generateDeviceToken () {
  return `dev_${crypto.randomBytes(24).toString('base64url')}`
}

function redactDeviceConfig (config) {
  const out = clone(config)
  if (out.webAuth) delete out.webAuth.password
  if (out.ota) delete out.ota.password
  out.redacted = true
  const hashBody = clone(out)
  delete hashBody.generatedAt
  delete hashBody.hash
  out.hash = sha256Json(hashBody)
  return out
}

// "host[:port]" (IPv4 / hostname, or [IPv6]:port) as typed by the operator.
function parseHostPort (value, defaultPort) {
  const raw = String(value || '').trim()
  if (!raw) return null
  let host = raw
  let port = defaultPort || 80
  const v6 = raw.match(/^\[([0-9a-f:.]+)\](?::(\d+))?$/i)
  const hp = raw.match(/^([a-z0-9.-]+)(?::(\d+))?$/i)
  if (v6) {
    host = v6[1]
    if (v6[2]) port = Number(v6[2])
  } else if (hp) {
    host = hp[1]
    if (hp[2]) port = Number(hp[2])
  } else {
    return null
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

function normalizeRemoteAddress (value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  return raw.replace(/^::ffff:/i, '')
}

function hashToken (token) {
  return `sha256:${crypto.createHash('sha256').update(String(token || '')).digest('hex')}`
}

function timingSafeEqual (a, b) {
  const aa = Buffer.from(String(a || ''))
  const bb = Buffer.from(String(b || ''))
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb)
}

function deviceHasToken (device) {
  return Boolean(device && (device.deviceTokenHash || device.deviceToken))
}

function verifyStoredToken (record, token) {
  if (!record || !token) return false
  if (record.tokenHash && timingSafeEqual(record.tokenHash, hashToken(token))) return true
  return Boolean(record.token && timingSafeEqual(hashToken(record.token), hashToken(token)))
}

function httpError (status, code, message, details) {
  const err = new Error(message)
  err.status = status
  err.payload = { error: { code, message, details: details || {} } }
  return err
}

// Compare two chip identifiers by FAMILY. Artifacts advertise the family
// ("ESP32-S3") while devices may report a variant/revision suffix
// ("esp32-s3-r0", "esp32-s3-r8"). Normalise to lowercase alphanumerics and
// drop a trailing rN revision marker so "ESP32-S3" matches "esp32-s3-r0".
function normalizeChipFamily (chip) {
  return String(chip || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/r\d+$/, '')
}
function chipFamiliesMatch (a, b) {
  const na = normalizeChipFamily(a)
  const nb = normalizeChipFamily(b)
  return na !== '' && nb !== '' && na === nb
}

module.exports = {
  YeyBoatsDisplayManager,
  PROTOCOL,
  devicesFromMdnsPacket,
  buildManagerMdnsPacket,
  parseMdnsPacket,
  normalizeOptions,
  httpError,
  basicAuthHeaders
}
