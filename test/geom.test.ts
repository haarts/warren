import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  closestOnPolyline, closestOnSegment, orthoConstrain, pointAtFraction,
  polylineLength, segmentIntersectsRect, walkPolyline,
} from '../src/geom.ts'

test('closestOnSegment clamps to the segment ends', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 10, y: 0 }
  assert.equal(closestOnSegment({ x: 5, y: 3 }, a, b).dist, 3)
  assert.equal(closestOnSegment({ x: -5, y: 0 }, a, b).t, 0)
  assert.equal(closestOnSegment({ x: 50, y: 0 }, a, b).t, 1)
  // A zero-length segment must not divide by zero.
  assert.equal(closestOnSegment({ x: 3, y: 4 }, a, a).dist, 5)
})

test('closestOnPolyline reports which segment was hit', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
  const hit = closestOnPolyline({ x: 11, y: 5 }, pts)
  assert.equal(hit.index, 1)
  assert.equal(hit.dist, 1)
})

test('orthoConstrain projects onto the nearest 45 degree ray', () => {
  const anchor = { x: 0, y: 0 }
  const horizontal = orthoConstrain(anchor, { x: 10, y: 1 })
  assert.equal(horizontal.y, 0)
  assert.equal(horizontal.x, 10)

  const diagonal = orthoConstrain(anchor, { x: 10, y: 9 })
  assert.ok(Math.abs(diagonal.x - diagonal.y) < 1e-9, 'lands on the 45 degree ray')

  // Degenerate input must not produce NaN.
  const same = orthoConstrain(anchor, { x: 0, y: 0 })
  assert.equal(same.x, 0)
  assert.equal(same.y, 0)
})

test('polylineLength sums every segment', () => {
  assert.equal(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 14 }]), 15)
  assert.equal(polylineLength([{ x: 1, y: 1 }]), 0)
})

test('walkPolyline spaces marks evenly along the path', () => {
  const marks = walkPolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }], 25, 0)
  assert.deepEqual(marks.map((m) => m.p.x), [0, 25, 50, 75, 100])
  assert.ok(marks.every((m) => m.angle === 0))
})

test('pointAtFraction walks past corners', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
  const mid = pointAtFraction(pts, 0.5)
  assert.deepEqual(mid.p, { x: 10, y: 0 })
  const end = pointAtFraction(pts, 1)
  assert.deepEqual(end.p, { x: 10, y: 10 })
})

test('segmentIntersectsRect catches segments crossing without endpoints inside', () => {
  const rect = { x: 0, y: 0, w: 10, h: 10 }
  assert.equal(segmentIntersectsRect({ x: -5, y: 5 }, { x: 15, y: 5 }, rect), true)
  assert.equal(segmentIntersectsRect({ x: 2, y: 2 }, { x: 3, y: 3 }, rect), true)
  assert.equal(segmentIntersectsRect({ x: -5, y: -5 }, { x: -1, y: -1 }, rect), false)
})
