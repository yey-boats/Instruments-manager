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
    network: { domain: 'local', hostnamePrefix: 'espdisp', namingPolicy: 'device-id' }
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
