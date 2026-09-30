export type TourRect = { top: number; left: number; width: number; height: number };

/** Fixed-position coordinates, including the visible viewport above a mobile keyboard. */
export function tourCardPosition(target: TourRect | null, card: { width: number; height: number }, viewport: TourRect) {
  const margin = 12, gap = 14;
  const minX = viewport.left + margin, minY = viewport.top + margin;
  const maxX = Math.max(minX, viewport.left + viewport.width - margin - card.width);
  const maxY = Math.max(minY, viewport.top + viewport.height - margin - card.height);
  const clampX = (x: number) => Math.max(minX, Math.min(x, maxX));
  const clampY = (y: number) => Math.max(minY, Math.min(y, maxY));
  const centre = { left: clampX(viewport.left + (viewport.width - card.width) / 2), top: clampY(viewport.top + (viewport.height - card.height) / 2) };
  if (!target) return centre;
  const x = clampX(target.left + (target.width - card.width) / 2);
  const y = clampY(target.top + (target.height - card.height) / 2);
  const candidates = [
    { left: x, top: target.top + target.height + gap },
    { left: x, top: target.top - card.height - gap },
    { left: target.left + target.width + gap, top: y },
    { left: target.left - card.width - gap, top: y },
  ];
  return candidates.find(p => p.left >= minX && p.left <= maxX && p.top >= minY && p.top <= maxY) ?? centre;
}

export function visibleTourTarget(selectors: string[], viewport: TourRect): TourRect | null {
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const style = getComputedStyle(element), r = element.getBoundingClientRect();
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0' || r.width <= 0 || r.height <= 0) continue;
      let top = Math.max(r.top, viewport.top), left = Math.max(r.left, viewport.left);
      let right = Math.min(r.right, viewport.left + viewport.width), bottom = Math.min(r.bottom, viewport.top + viewport.height);
      // A target can have a non-zero box while hidden outside a scrolling pane.
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const s = getComputedStyle(parent), box = parent.getBoundingClientRect();
        if (s.visibility === 'hidden' || s.opacity === '0') { right = left; break; }
        if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
        if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      }
      if (right > left && bottom > top) return { top, left, width: right - left, height: bottom - top };
    }
  }
  return null;
}
