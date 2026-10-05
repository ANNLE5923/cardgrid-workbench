import test from 'node:test';
import assert from 'node:assert/strict';
import {gridDims, spherePoints, wavePhase} from '../../../src/shared/ui/sphere/card-layout.ts';

const approx = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('spherePoints handles empty and single counts', () => {
  assert.deepEqual(spherePoints(0, 100), []);
  const one = spherePoints(1, 100);
  assert.equal(one.length, 1);
  approx(one[0].y, 100); // single point sits at the top pole
});

test('spherePoints keeps every point on the sphere, distinct, facing outward', () => {
  const R = 120, pts = spherePoints(40, R);
  assert.equal(pts.length, 40);
  const keys = new Set(pts.map(p => `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`));
  assert.equal(keys.size, 40);
  for (const p of pts) approx(p.x * p.x + p.y * p.y + p.z * p.z, R * R, 1e-7);
});

test('azimuth/elevation reproduce the point via rotateY->rotateX->translateZ', () => {
  const R = 80, D = Math.PI / 180;
  for (const p of spherePoints(25, R)) {
    const a = p.azimuth * D, e = p.elevation * D;
    approx(Math.cos(e) * Math.sin(a) * R, p.x, 1e-6);
    approx(-Math.sin(e) * R, p.y, 1e-6);
    approx(Math.cos(e) * Math.cos(a) * R, p.z, 1e-6);
  }
});

test('gridDims gives near-square rows/cols and honours maxCols', () => {
  assert.deepEqual(gridDims(0), {rows: 0, cols: 0});
  assert.deepEqual(gridDims(1), {rows: 1, cols: 1});
  assert.deepEqual(gridDims(9), {rows: 3, cols: 3});
  assert.deepEqual(gridDims(10), {rows: 3, cols: 4});
  assert.deepEqual(gridDims(100, 5), {rows: 20, cols: 5});
});

test('wavePhase increases across rows and columns', () => {
  const cols = gridDims(12).cols;
  assert.ok(wavePhase(1, cols) > wavePhase(0, cols)); // next column
  assert.ok(wavePhase(cols, cols) > wavePhase(0, cols)); // next row
});
