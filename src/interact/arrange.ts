/**
 * Moving things about: turning a box.
 */
import type { BoxItem } from '../model/types.ts'

/** Sets a box's turn, kept in [0, 360) and dropped altogether when it is square again. */
export function setBoxRotation(box: BoxItem, deg: number): void {
  const d = ((deg % 360) + 360) % 360
  if (Math.abs(d) < 1e-6 || Math.abs(d - 360) < 1e-6) delete box.rotationDeg
  else box.rotationDeg = Number(d.toFixed(2))
}

