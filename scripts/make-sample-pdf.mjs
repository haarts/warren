// Generates samples/sample-floorplan.pdf: a deliberately plain top-down plan with one
// printed dimension, so the app can be tried (and calibrated) without a real architect PDF.
import { writeFileSync, mkdirSync } from 'node:fs'

const W = 842, H = 595

const content = `
1 w 0.15 0.15 0.15 RG
% outer walls: 500 x 340 pt
120 120 500 340 re S
118 118 504 344 re S
% interior walls
370 120 m 370 300 l S
370 300 m 620 300 l S
250 300 m 250 460 l S
120 300 m 250 300 l S
% door gaps drawn as short white breaks are overkill for a sample; keep it simple
0.45 0.45 0.45 RG 0.6 w
% dimension line under the building
120 96 m 620 96 l S
120 104 m 120 88 l S
620 104 m 620 88 l S
BT /F1 9 Tf 0.2 0.2 0.2 rg 355 82 Td (10000) Tj ET
BT /F1 10 Tf 160 400 Td (Living) Tj ET
BT /F1 10 Tf 420 380 Td (Kitchen) Tj ET
BT /F1 10 Tf 420 200 Td (Bedroom) Tj ET
BT /F1 10 Tf 160 200 Td (Hall) Tj ET
BT /F1 12 Tf 120 500 Td (Sample floor plan - ground floor 1:100) Tj ET
`.trim()

const objects = [
  '<</Type/Catalog/Pages 2 0 R>>',
  '<</Type/Pages/Kids[3 0 R]/Count 1>>',
  `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${W} ${H}]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>`,
  `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
  '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
]

let pdf = '%PDF-1.4\n'
const offsets = []
objects.forEach((body, i) => {
  offsets.push(pdf.length)
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
})
const xrefPos = pdf.length
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`
pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`

mkdirSync(new URL('../samples/', import.meta.url), { recursive: true })
writeFileSync(new URL('../samples/sample-floorplan.pdf', import.meta.url), pdf, 'latin1')
console.log(`wrote samples/sample-floorplan.pdf (${pdf.length} bytes) — the 10000 mm dimension spans 500 pt, so calibration should give 20 mm/pt`)
