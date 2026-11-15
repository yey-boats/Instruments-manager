class MockFirmware {
  constructor (manager, options) {
    this.manager = manager
    this.deviceId = options.deviceId || 'yey-d-mock'
    this.auth = options.auth
    this.name = options.name !== undefined ? options.name : 'Mock ESP Display'
    this.screen = 'dashboard'
    this.theme = 'day'
    // Theme names this build's theme.set accepts (all six by default; older
    // builds took only day/night, instruments#76).
    this.themes = options.themes || ['day', 'night', 'high-contrast', 'red-night', 'classic', 'sun']
    this.brightness = 0.8
    // Firmware acks carry a bare status string ("ok", "busy",
    // "invalid_payload", ...); option ackStrings reproduces that.
    this.ackStrings = Boolean(options.ackStrings)
    // theme.set answers busy while set (the UI task queue is full).
    this.busy = false
    // The config last loaded, the one whose hash the display reports as
    // applied, and the copy persisted to flash (re-applied on every boot).
    this.config = null
    // MIDL record store (MIDL-only firmware): manager / local records by id,
    // the index, and what is shown. Embedded records are implied.
    this.records = new Map()
    this.index = null
    this.record = 'dashboard'
    // Push API state: the manager token this display holds (X-YeyBoats-
    // Authorization) and its web password (Basic); `reachable` false makes
    // every HTTP request fail like an unreachable device.
    this.managerToken = options.managerToken || null
    this.webPassword = options.webPassword || null
    this.reachable = options.reachable !== false
    this.httpLog = []
    this.applied = null
    this.persisted = null
    // Boot instant on Date.now()'s clock: the heartbeat reports the uptime
    // since then (the firmware's ui.uptime_ms, millis()). Up an hour when
    // the mock is created; reboot() starts it again from zero.
    this.bootAt = Date.now() - 3600000
    this.firmware = {
      name: 'yey-display',
      version: options.version || '0.5.0-dev',
      channel: 'dev',
      git: { commit: 'mock000', dirty: false },
      partition: { running: 'ota_0', next: 'ota_1' },
      rollback: { supported: true, pendingConfirm: false }
    }
    this.display = options.display || {
      width: 480,
      height: 480,
      rotation: 0,
      colorDepth: 16,
      density: 'mdpi',
      shape: 'square'
    }
    this.capabilities = options.capabilities || {
      touch: true,
      touchInterrupt: true,
      bleConfig: true,
      ota: true,
      pullOta: true,
      nmea0183Wifi: true,
      autopilotControls: true,
      widgets: {
        numeric: true,
        text: true,
        gauge: true,
        compass: true,
        windRose: true,
        trend: true,
        bar: true,
        button: true,
        autopilot: true,
        map: false
      },
      fonts: {
        scalable: false,
        sizes: [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56],
        families: ['default']
      }
    }
  }

  identity () {
    return {
      id: this.deviceId,
      name: this.name,
      model: 'ESP32-4848S040',
      board: 'sunton_4848s040',
      mac: 'AA:BB:CC:DD:EE:99',
      chip: 'ESP32-S3',
      flashBytes: 16777216,
      psramBytes: 8388608,
      display: this.display,
      touch: {
        enabled: true,
        width: this.display.width,
        height: this.display.height,
        controller: 'GT911',
        interrupt: true
      },
      firmware: this.firmware,
      capabilities: this.capabilities
    }
  }

  register () {
    return this.manager.registerDevice({
      protocol: 'yeyboats.management.v2',
      device: this.identity()
    }, this.auth)
  }

  fetchConfig () {
    this.config = this.manager.generateConfig(this.deviceId)
    this.applyConfig(this.config)
    return this.config
  }

  // Like apply_config_object(): a config's ui.theme is applied (and so
  // overwrites the theme kept in NVS); an unknown one is rejected, and a
  // config with a rejected field is applied as a valid subset only: its hash
  // is not recorded as applied and it is not persisted.
  midlClass () {
    if (String(this.display.shape || '') === 'round') return 'round-360'
    const w = Math.max(this.display.width, this.display.height)
    return w >= 1024 ? 'landscape-1024x600' : (w >= 800 ? 'landscape-800x480' : 'square-480')
  }

  // Pull: compare each listed record's hash with the store, fetch only the
  // changed ones, drop manager records that are no longer listed.
  syncMidl (block) {
    if (!block || !Array.isArray(block.records)) return
    for (const r of block.records) {
      const have = this.records.get(r.id)
      if (have && have.hash === r.hash) continue
      const rec = this.manager.deviceRecordFor(this.deviceId, r.id, this.auth)
      this.records.set(r.id, { id: rec.id, title: rec.title, source: 'manager', hash: rec.hash, doc: rec.doc, docText: JSON.stringify(rec.doc) })
      this.pulled = (this.pulled || []).concat(r.id)
    }
    for (const [id, r] of [...this.records]) {
      if (r.source === 'manager' && !block.records.some((x) => x.id === id)) this.records.delete(id)
    }
    if (block.index) this.index = block.index
  }

  // The device's push API (/api/midl/...), for manager._deviceHttpRequest.
  // Resolves { httpStatus, json } or rejects like the manager's transport.
  http (url, method, text, auth) {
    const u = new URL(url)
    this.httpLog.push({ method, path: u.pathname + u.search, auth: auth ? { bearer: auth.bearer || null, basic: Boolean(auth.password) } : null, body: text })
    const fail = (status, body) => Promise.reject(Object.assign(new Error(`device returned HTTP ${status}`), {
      status, payload: { error: { code: status === 502 ? 'device_unreachable' : 'device_http_error', details: { body } } }
    }))
    if (!this.reachable) return fail(502)
    const tokenOk = Boolean(this.managerToken && auth && auth.bearer === this.managerToken)
    const basicOk = Boolean(this.webPassword && auth && auth.password === this.webPassword)
    if (!tokenOk && !basicOk) return fail(401, { error: 'unauthorized' })
    const source = tokenOk ? 'manager' : 'local'
    const m = /^\/api\/midl\/records\/([a-z0-9_-]{1,32})$/.exec(u.pathname)
    if (m && method === 'PUT') {
      const body = JSON.parse(text)
      const docText = JSON.stringify(body.doc)
      // The firmware stores the hash the manager supplies (no re-serializing).
      if (typeof body.hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(body.hash)) return fail(422, { error: 'invalid', message: 'hash required' })
      const hash = body.hash
      this.records.set(m[1], { id: m[1], title: body.title, source, hash, doc: body.doc, docText })
      if (u.searchParams.get('activate') === '1') {
        this.record = m[1]
        this.screen = u.searchParams.get('screen') || this.screen
      }
      return Promise.resolve({ httpStatus: 200, json: { id: m[1], hash, screens: (body.doc.screens || []).map((sc) => sc.id) } })
    }
    if (m && method === 'DELETE') {
      if (!this.records.delete(m[1])) return fail(404)
      return Promise.resolve({ httpStatus: 200, json: { ok: true } })
    }
    if (u.pathname === '/api/midl/index' && method === 'PUT') {
      this.index = JSON.parse(text)
      return Promise.resolve({ httpStatus: 200, json: { ok: true } })
    }
    return fail(404)
  }

  applyConfig (cfg, booting) {
    if (cfg.midl) this.syncMidl(cfg.midl)
    let ok = true
    if (cfg.ui && typeof cfg.ui.theme === 'string') {
      if (this.themes.includes(cfg.ui.theme)) this.theme = cfg.ui.theme
      else ok = false
    }
    if (!ok) return false
    const prevHash = this.applied && this.applied.hash
    this.applied = { version: cfg.version, hash: cfg.hash }
    // Flash-wear rule: persist only when the hash changed.
    if (!booting && cfg.hash !== prevHash) this.persisted = JSON.parse(JSON.stringify(cfg))
    return true
  }

  // Power cycle: the theme in NVS survives; load_persisted_config() then
  // re-applies the persisted config (incl. its ui.theme) and reports its hash.
  reboot () {
    this.bootAt = Date.now()
    this.applied = null
    if (this.persisted) {
      this.config = JSON.parse(JSON.stringify(this.persisted))
      this.applyConfig(this.config, true)
    }
  }

  uptimeMs () {
    return Math.max(0, Date.now() - this.bootAt)
  }

  heartbeat () {
    return this.manager.updateStatus(this.deviceId, {
      uptimeMs: this.uptimeMs(),
      network: {
        mode: 'sta',
        ssid: 'BoatWiFi',
        ip: '192.168.1.99',
        rssi: -52,
        hostname: this.config ? this.config.network.hostname : this.deviceId,
        domain: 'local',
        fqdn: this.config ? this.config.network.fqdn : `${this.deviceId}.local`,
        mdns: { enabled: true, services: ['_yeyboats._tcp', '_arduino._tcp'] }
      },
      signalk: {
        host: 'signalk.local',
        port: 3000,
        connected: true,
        lastDeltaAgeMs: 200
      },
      ui: {
        uptime_ms: this.uptimeMs(),
        screen: this.screen,
        theme: this.theme,
        brightness: this.brightness,
        record: this.record
      },
      midl: {
        version: '1.0.0',
        class: this.midlClass(),
        records: [...this.records.values()].map((r) => ({ id: r.id, hash: r.hash, source: r.source }))
      },
      display: this.display,
      firmware: this.firmware,
      ota: {
        enabled: true,
        mode: 'arduino-ota',
        address: this.config ? this.config.ota.address : `${this.deviceId}.local`,
        port: 3232,
        passwordSet: false
      },
      config: this.applied
        ? { version: this.applied.version, hash: this.applied.hash, applied: true }
        : { version: 0, hash: null, applied: false },
      errors: []
    }, this.auth)
  }

  pollAndExecute () {
    const polled = this.manager.getCommands(this.deviceId, this.auth, 10)
    return polled.commands.map((command) => {
      const result = this.execute(command)
      const sent = this.ackStrings ? (result.ok === false ? result.code || 'failed' : 'ok') : result
      this.manager.ackCommand(this.deviceId, command.id, { result: sent }, this.auth)
      return { command, result }
    })
  }

  execute (command) {
    try {
      switch (command.type) {
        case 'screen.set':
          this.screen = command.payload.screen
          return { ok: true, message: 'screen changed' }
        case 'theme.set':
          if (this.busy) return { ok: false, code: 'busy', message: 'busy' }
          if (!this.themes.includes(command.payload.theme)) {
            return { ok: false, code: 'invalid_payload', message: 'invalid_payload' }
          }
          this.theme = command.payload.theme
          return { ok: true, message: 'theme changed' }
        case 'brightness.set':
          this.brightness = command.payload.value
          return { ok: true, message: 'brightness changed' }
        case 'config.reload':
        case 'layout.reload':
          this.fetchConfig()
          return { ok: true, message: 'config reloaded' }
        case 'firmware.update':
          return this.executeFirmwareUpdate(command)
        default:
          return {
            ok: false,
            code: 'unsupported_command',
            message: `unsupported command ${command.type}`
          }
      }
    } catch (err) {
      return { ok: false, code: 'failed', message: err.message }
    }
  }

  executeFirmwareUpdate (command) {
    const jobId = command.payload.jobId
    this.manager.updateFirmwareProgress(this.deviceId, jobId, {
      state: 'downloading',
      bytesRead: command.payload.size || 0,
      bytesTotal: command.payload.size || 0,
      percent: 100
    }, this.auth)
    this.manager.updateFirmwareProgress(this.deviceId, jobId, {
      state: 'rebooting',
      bytesRead: command.payload.size || 0,
      bytesTotal: command.payload.size || 0,
      percent: 100
    }, this.auth)
    this.firmware = {
      ...this.firmware,
      version: command.payload.version,
      partition: { running: 'ota_1', next: 'ota_0' }
    }
    this.manager.confirmFirmware(this.deviceId, {
      jobId,
      firmware: this.firmware,
      rollbackConfirmed: true
    }, this.auth)
    return { ok: true, message: 'firmware updated' }
  }
}

module.exports = { MockFirmware }
