'use strict'
// Display classes the flash UI offers (device type + resolution), and the
// board -> class table. Firmware targets only; screens are MIDL records and
// render per MIDL class (lib/midl.js MIDL_CLASSES).

const DISPLAY_CLASSES = {
  'sunton-480': {
    label: 'Sunton 4848S040 — 480×480 square',
    width: 480, height: 480, shape: 'square'
  },
  'waveshare-4_3-800x480': {
    label: 'Waveshare 4.3" — 800×480 wide',
    width: 800, height: 480, shape: 'wide'
  },
  'waveshare-5-800x480': {
    label: 'Waveshare 5" — 800×480 wide',
    width: 800, height: 480, shape: 'wide'
  },
  'waveshare-5-1024x600': {
    label: 'Waveshare 5" — 1024×600 wide',
    width: 1024, height: 600, shape: 'wide'
  },
  'waveshare-7-800x480': {
    label: 'Waveshare 7" — 800×480 wide',
    width: 800, height: 480, shape: 'wide'
  },
  'waveshare-7b-1024x600': {
    label: 'Waveshare 7"B — 1024×600 wide',
    width: 1024, height: 600, shape: 'wide'
  }
}

const BOARD_TO_CLASS = {
  sunton_4848s040: 'sunton-480',
  waveshare_touch_lcd_4: 'sunton-480',          // also 480×480 square
  waveshare_touch_lcd_4_3: 'waveshare-4_3-800x480',
  waveshare_touch_lcd_4_3b: 'waveshare-4_3-800x480',
  waveshare_touch_lcd_5_800x480: 'waveshare-5-800x480',
  waveshare_touch_lcd_5_1024x600: 'waveshare-5-1024x600',
  waveshare_touch_lcd_7_800x480: 'waveshare-7-800x480',
  waveshare_touch_lcd_7b_1024x600: 'waveshare-7b-1024x600'
}

function classifyBoard (board) {
  if (!board) return 'sunton-480'
  return BOARD_TO_CLASS[board] || 'sunton-480'
}

function listDisplayClasses () {
  return Object.keys(DISPLAY_CLASSES).map((id) => ({
    id,
    ...DISPLAY_CLASSES[id]
  }))
}

module.exports = { DISPLAY_CLASSES, BOARD_TO_CLASS, classifyBoard, listDisplayClasses }
