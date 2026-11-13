// #37: switching dashboards on /midl-preview.html must not leave pixels of the
// previous dashboard behind (the renderer fills tile rectangles only, so the
// gutters between tiles kept the old frame).
const fs = require('fs')
const http = require('http')
const path = require('path')
const { test, expect } = require('@playwright/test')

const PUBLIC = path.join(__dirname, '..', 'public')
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' }

async function startStatic () {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '')
    const file = path.join(PUBLIC, rel)
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream')
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('switching dashboards repaints the whole canvas (no ghost pixels at tile seams)', async ({ page }) => {
  const srv = await startStatic()
  try {
    await page.goto(`${srv.url}/midl-preview.html`)
    // The page ships placeholder options; wait for the library's (value "0").
    await expect(page.locator('#dash option[value="0"]')).toHaveCount(1)
    const count = await page.locator('#dash option').count()
    expect(count).toBeGreaterThan(1)
    // Paint a sentinel colour the renderer never uses over the whole canvas,
    // then switch dashboard: no sentinel pixel may survive the repaint.
    await page.evaluate(() => {
      const ctx = document.getElementById('cv').getContext('2d')
      ctx.fillStyle = 'rgb(255,0,255)'
      ctx.fillRect(0, 0, 480, 480)
    })
    // The change handler repaints synchronously inside load().
    await page.selectOption('#dash', String(count - 1))
    const leftover = await page.evaluate(() => {
      const d = document.getElementById('cv').getContext('2d').getImageData(0, 0, 480, 480).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) n++
      return n
    })
    expect(leftover, 'pixels of the previous frame left on the canvas').toBe(0)
  } finally {
    await srv.close()
  }
})
