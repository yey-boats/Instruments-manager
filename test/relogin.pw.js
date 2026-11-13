const http = require('http')
const { test, expect } = require('@playwright/test')
const plugin = require('..')
const { makeManager } = require('./test-utils')

// Boots a minimal http server that serves a real manager UI page rendered via
// plugin._test.renderUi, so the injected relogin modal + submit-intercept
// script (renderUiShell) are present exactly as shipped. The test then stubs
// window.fetch to resolve to a login-looking response and asserts the modal
// appears on a POST form submit.
async function startHarness () {
  const { manager } = makeManager({
    auth: { mode: 'dev-shared-token', devToken: 'test-token' },
    network: { domain: 'local', hostnamePrefix: 'yey-d', namingPolicy: 'device-id' }
  })

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/plugins/yey-boats-display-manager/ui/devices') {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(plugin._test.renderUi(manager, 'devices', { params: {}, query: {} }))
        return
      }
      res.statusCode = 404
      res.end('not found')
    } catch (err) {
      res.statusCode = 500
      res.end(err.stack || err.message)
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

test('relogin modal appears when a manager POST resolves to the login page', async ({ page }) => {
  const harness = await startHarness()
  try {
    // Install the fetch stub before any page script runs.
    await page.addInitScript(() => {
      window.fetch = async () => ({ status: 200, url: 'http://x/admin/#/login' })
    })

    await page.goto(`${harness.baseUrl}/plugins/yey-boats-display-manager/ui/devices`)

    // Modal starts hidden.
    await expect(page.locator('#relogin-modal')).toBeHidden()

    // Inject a tiny POST form and submit it so the intercept script runs.
    await page.evaluate(() => {
      const f = document.createElement('form')
      f.method = 'post'
      f.action = '/plugins/yey-boats-display-manager/ui/devices/clear-offline'
      document.body.appendChild(f)
      if (f.requestSubmit) f.requestSubmit()
      else f.submit()
    })

    await expect(page.locator('#relogin-modal')).toBeVisible()
  } finally {
    await harness.close()
  }
})

// #42: the intercept must send what a native submit sends (urlencoded, with
// the clicked button's name/value), and must not fire when the form's own
// onsubmit (the confirm() prompts on destructive actions) cancels it.
test('form submits go out urlencoded with the submitter, and a cancelled confirm sends nothing', async ({ page }) => {
  const harness = await startHarness()
  try {
    await page.addInitScript(() => {
      window.__posts = []
      window.fetch = async (url, init) => {
        const b = init && init.body
        window.__posts.push({
          url: String(url),
          type: b instanceof URLSearchParams ? 'urlencoded' : (b instanceof FormData ? 'multipart' : typeof b),
          body: b instanceof URLSearchParams ? b.toString() : null
        })
        // a same-page #hash so the follow-up location.assign() does not reload
        return { status: 200, url: location.href.split('#')[0] + '#done', headers: { get: () => 'text/html' }, text: async () => '' }
      }
    })
    await page.goto(`${harness.baseUrl}/plugins/yey-boats-display-manager/ui/devices`)

    await page.evaluate(() => {
      const f = document.createElement('form')
      f.method = 'post'
      f.action = '/plugins/yey-boats-display-manager/profiles/import-dashboard'
      f.innerHTML = '<input name="presetId" value="p1"><button name="mode" value="apply" id="go">Go</button>'
      document.body.appendChild(f)
    })
    await page.click('#go')
    await expect.poll(() => page.evaluate(() => window.__posts.length)).toBe(1)
    const sent = await page.evaluate(() => window.__posts[0])
    expect(sent.type).toBe('urlencoded')
    expect(new URLSearchParams(sent.body).get('presetId')).toBe('p1')
    expect(new URLSearchParams(sent.body).get('mode')).toBe('apply')

    // A destructive form whose confirm() is dismissed must not POST.
    await page.goto(`${harness.baseUrl}/plugins/yey-boats-display-manager/ui/devices`)
    page.once('dialog', (d) => d.dismiss())
    await page.evaluate(() => {
      const f = document.createElement('form')
      f.method = 'post'
      f.action = '/plugins/yey-boats-display-manager/devices/x/delete'
      f.setAttribute('onsubmit', "return confirm('Remove this device?')")
      f.innerHTML = '<button id="rm">Remove</button>'
      document.body.appendChild(f)
    })
    await page.click('#rm')
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => window.__posts.length)).toBe(0)
  } finally {
    await harness.close()
  }
})
