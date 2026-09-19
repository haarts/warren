/** Metric only, on purpose: this is a Dutch build. mm for sizes, m for run lengths. */

export function formatMetres(mm: number, decimals = 1): string {
  if (!isFinite(mm)) return '—'
  return `${(mm / 1000).toFixed(decimals)} m`
}

/** Pick a round scale-bar length (mm) whose on-screen size lands near `targetPx`. */
export function niceScaleLength(mmPerPx: number, targetPx: number): number {
  const raw = mmPerPx * targetPx
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const mult of [1, 2, 2.5, 5, 10]) {
    if (pow * mult >= raw) return pow * mult
  }
  return pow * 10
}
