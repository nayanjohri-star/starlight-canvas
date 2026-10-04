// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function pngDimensions(png) {
  assert.ok(Buffer.isBuffer(png) && png.length >= 33, 'native screenshot has a complete PNG IHDR');
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), 'native screenshot has the PNG signature');
  assert.equal(png.readUInt32BE(8), 13, 'PNG IHDR has its required length');
  assert.equal(png.toString('ascii', 12, 16), 'IHDR', 'PNG first chunk is IHDR');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.ok(width > 0 && height > 0, 'native screenshot dimensions are positive');
  return { width, height };
}

// Page.screenshot's clip calculation mixes Chromium's deprecated visual
// viewport scale with CSS sizes at real browser zoom. Let native CDP capture
// the entire visible surface instead, then prove its actual physical size.
export async function captureNativeViewport(page, { path, width, height }) {
  assert.ok(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0);
  const metrics = await page.evaluate(() => ({ innerWidth, innerHeight, dpr: devicePixelRatio,
    visualScale: visualViewport.scale, cssZoom: getComputedStyle(document.documentElement).zoom }));
  assert.equal(metrics.visualScale, 1, 'native screenshot is not a pinch-zoom capture');
  assert.ok(['1', 'normal'].includes(metrics.cssZoom), 'native screenshot does not use CSS zoom');
  const physicalViewport = { width: metrics.innerWidth * metrics.dpr, height: metrics.innerHeight * metrics.dpr };
  // Same rounding allowance as native window calibration; a 125% CSS-width
  // crop differs by hundreds of pixels and must fail these assertions.
  assert.ok(Math.abs(physicalViewport.width - width) <= 1.5 && Math.abs(physicalViewport.height - height) <= 1.5,
    `native window physical viewport changed: ${JSON.stringify({ requested: { width, height }, physicalViewport, metrics })}`);
  const session = await page.context().newCDPSession(page);
  try {
    const result = await session.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
    });
    const png = Buffer.from(result.data, 'base64');
    writeFileSync(path, png); // Retain the actual image even if its dimensions fail.
    const dimensions = pngDimensions(png);
    assert.ok(Math.abs(dimensions.width - physicalViewport.width) <= 1.5
      && Math.abs(dimensions.height - physicalViewport.height) <= 1.5
      && Math.abs(dimensions.width - width) <= 1.5 && Math.abs(dimensions.height - height) <= 1.5,
    `native full viewport PNG size mismatch: ${JSON.stringify({ png: dimensions, requested: { width, height }, physicalViewport, metrics })}`);
    return { method: 'CDP Page.captureScreenshot without clip', path, ...dimensions,
      requestedPhysicalViewport: { width, height }, physicalViewport, metrics };
  } finally { await session.detach(); }
}
