const fs = require('fs')
const path = require('path')
const midlRecords = require('./midl-records')

function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson (file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw err
  }
}

function writeJson (file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

function appendJsonl (file, value) {
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`)
}

class JsonStore {
  constructor (dataDir) {
    this.dataDir = dataDir
    this.registryFile = path.join(dataDir, 'registry.json')
    this.profilesFile = path.join(dataDir, 'profiles.json')
    this.commandsFile = path.join(dataDir, 'commands.json')
    this.discoveryFile = path.join(dataDir, 'discovery.json')
    this.firmwareFile = path.join(dataDir, 'firmware-catalog.json')
    this.jobsFile = path.join(dataDir, 'firmware-jobs.json')
    this.provisioningFile = path.join(dataDir, 'provisioning.json')
    this.settingsFile = path.join(dataDir, 'settings.json')
    this.auditFile = path.join(dataDir, 'audit.jsonl')
  }

  init () {
    ensureDir(this.dataDir)
    this.registry = readJson(this.registryFile, { devices: {} })
    this.profiles = readJson(this.profilesFile, defaultProfiles())
    this.migrateToMidl()
    this.commands = readJson(this.commandsFile, { commands: [] })
    this.discovery = readJson(this.discoveryFile, { devices: {} })
    this.firmware = readJson(this.firmwareFile, { artifacts: [] })
    this.jobs = readJson(this.jobsFile, { jobs: [] })
    this.provisioning = readJson(this.provisioningFile, { tokens: [] })
    this.settings = readJson(this.settingsFile, defaultSettings())
  }

  // One-time migration (MIDL-only screens): every stored v2 profile
  // (`config.layout` / `config.widgets`) becomes MIDL records in
  // `profile.midl`, and v2 screen keys are dropped from device overrides.
  // The files as they were are kept next to them as
  // `<name>.v2-backup.json` (never overwritten once written).
  migrateToMidl () {
    const profiles = (this.profiles && this.profiles.profiles) || {}
    const changed = []
    const converted = {}
    for (const [id, profile] of Object.entries(profiles)) {
      if (!profile || typeof profile !== 'object') continue
      const v2 = midlRecords.hasV2Screens(profile.config)
      if (!v2 && profile.midl) continue
      if (v2) {
        const split = midlRecords.splitV2Config(profile.config, profile.midl)
        converted[id] = clone(profile)
        profile.config = split.config
        profile.midl = split.midl
        profile.migratedFromV2 = {
          at: new Date().toISOString(),
          records: split.migrated.records.map((r) => r.id),
          builtinScreensDropped: split.migrated.dropped
        }
      } else {
        profile.midl = midlRecords.emptyMidl()
      }
      changed.push(id)
    }
    const devices = (this.registry && this.registry.devices) || {}
    const touchedDevices = []
    for (const device of Object.values(devices)) {
      const o = device && device.overrides
      if (o && typeof o === 'object' && (o.layout !== undefined || o.widgets !== undefined)) touchedDevices.push(device)
    }
    if (!changed.length && !touchedDevices.length) return { profiles: [], devices: [] }
    if (Object.keys(converted).length) backupOnce(this.profilesFile)
    if (touchedDevices.length) backupOnce(this.registryFile)
    for (const device of touchedDevices) {
      delete device.overrides.layout
      delete device.overrides.widgets
    }
    if (changed.length && fs.existsSync(this.profilesFile)) this.saveProfiles()
    if (touchedDevices.length) this.saveRegistry()
    if (Object.keys(converted).length) {
      this.audit('profiles.migrated.midl', 'profiles', { profiles: Object.keys(converted) })
    }
    return { profiles: changed, devices: touchedDevices.map((d) => d.id) }
  }

  saveRegistry () { writeJson(this.registryFile, this.registry) }
  saveProfiles () { writeJson(this.profilesFile, this.profiles) }
  saveCommands () { writeJson(this.commandsFile, this.commands) }
  saveDiscovery () { writeJson(this.discoveryFile, this.discovery) }
  saveFirmware () { writeJson(this.firmwareFile, this.firmware) }
  saveJobs () { writeJson(this.jobsFile, this.jobs) }
  saveProvisioning () { writeJson(this.provisioningFile, this.provisioning) }
  saveSettings () { writeJson(this.settingsFile, this.settings) }

  audit (type, subject, data) {
    appendJsonl(this.auditFile, {
      time: new Date().toISOString(),
      type,
      subject,
      data: data || {}
    })
  }
}

function clone (v) {
  return JSON.parse(JSON.stringify(v))
}

function backupFileFor (file) {
  return file.replace(/\.json$/, '') + '.v2-backup.json'
}

function backupOnce (file) {
  const backup = backupFileFor(file)
  if (!fs.existsSync(file) || fs.existsSync(backup)) return
  fs.copyFileSync(file, backup)
}

function defaultSettings () {
  return { network: { ssid: '', password: '', mdnsDomain: 'yey.boats' }, ota: { password: '' }, numbering: { prefix: 'yey-d-', next: 1, pad: 3 } }
}

function defaultProfiles () {
  return {
    profiles: {
      default: {
        id: 'default',
        name: 'Default ESP Display',
        version: 1,
        updatedAt: new Date(0).toISOString(),
        config: {
          settings: {
            defaultScreen: 'dashboard',
            theme: 'day',
            brightness: 0.8,
            demoMode: false
          },
          sources: {
            priority: ['signalk', 'nmea0183Wifi', 'nmea2000'],
            timeoutsMs: {
              signalk: 10000,
              nmea0183Wifi: 3000,
              nmea2000: 2000
            }
          },
          nmea0183Wifi: {
            enabled: true,
            mode: 'tcp',
            host: 'signalk.local',
            port: 10110
          },
          autopilot: {
            enabled: true,
            allowEngage: false,
            allowStandby: true,
            allowHeadingAdjust: true,
            backend: 'signalk'
          },
          debug: {
            logLevel: 'info',
            touchMode: 'irq'
          }
        },
        // Screens: the embedded (built-in) records only; nothing to push.
        midl: midlRecords.emptyMidl()
      }
    }
  }
}

module.exports = {
  JsonStore,
  defaultProfiles,
  backupFileFor,
  readJson,
  writeJson,
  ensureDir
}
