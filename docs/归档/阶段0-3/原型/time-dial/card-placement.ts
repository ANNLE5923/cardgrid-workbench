export type DialBounds = Readonly<{ left: number; top: number; width: number; height: number }>;

export function dialRadiusAt(x: number, y: number, dial: DialBounds): number | null {
  const scale = Math.min(dial.width / 400, dial.height / 400);
  if (!scale) return null;
  const contentLeft = dial.left + (dial.width - 400 * scale) / 2;
  const contentTop = dial.top + (dial.height - 400 * scale) / 2;
  return Math.hypot((x - contentLeft) / scale - 200, (y - contentTop) / scale - 200);
}

/** Crossing the outside edge is deliberate; moving from inner to outer ring is not a return gesture. */
export function pulledBeyondDial(x: number, y: number, dial: DialBounds, startingRadius: number): boolean {
  const radius = dialRadiusAt(x, y, dial);
  return radius !== null && radius >= 190 && radius - startingRadius >= 45;
}

/** The upper edge of the held card meets the outer ring first, then the inner ring. */
export function previewMinuteAtCardEdge(x: number, y: number, dial: DialBounds, pointerMinute: number, swapped: boolean): number | null {
  const scale = Math.min(dial.width / 400, dial.height / 400);
  if (!scale) return null;
  const contentLeft = dial.left + (dial.width - 400 * scale) / 2;
  const contentTop = dial.top + (dial.height - 400 * scale) / 2;
  const px = (x - contentLeft) / scale - 200;
  const py = (y - contentTop) / scale - 200;
  const distance = Math.hypot(px, py);
  if (distance > 185) return null;
  const half: 0 | 1 = distance <= 136 ? (swapped ? 1 : 0) : (swapped ? 0 : 1);
  const angle = (Math.atan2(px, -py) * 180 / Math.PI + 360) % 360;
  const rotation = 180 - pointerMinute / 720 * 360;
  const unrotated = (angle - rotation + 1440) % 360;
  const minuteOfHalf = Math.min(715, Math.round((unrotated * 2) / 5) * 5);
  return half * 720 + minuteOfHalf;
}

/** Short viewports may visually overlap the dial before dragging; the gesture still enters the outer ring first. */
export function stagedCardPreview(x: number, y: number, dial: DialBounds, pointerMinute: number, swapped: boolean, upwardPixels: number): number | null {
  if (upwardPixels < 18) return null;
  const hit = previewMinuteAtCardEdge(x, y, dial, pointerMinute, swapped);
  if (hit === null) return null;
  if (upwardPixels < 75) return (swapped ? 0 : 1) * 720 + hit % 720;
  return hit;
}
