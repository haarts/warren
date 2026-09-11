import type { App } from '../app.ts'
import { pageCount, renderThumbnail } from '../io/pdf.ts'
import { assetData } from '../model/assets.ts'
import { el } from './dom.ts'
import { openModal } from './modal.ts'

const MAX_THUMBS = 60

/** Page picker. Architect PDFs are often multi-sheet, so choosing the right page matters. */
export async function openPdfImportDialog(
  app: App, assetId: string, fileName: string, target: 'current' | 'new',
): Promise<void> {
  const base64 = assetData(assetId)
  if (!base64) return
  const total = await pageCount(assetId, base64)
  let selected = 1

  const grid = el('div', { class: 'page-grid' })
  const status = el('div', { class: 'hint' }, `${fileName} · ${total} page${total === 1 ? '' : 's'}`)

  const handle = openModal((close) => ({
    title: 'Choose a page',
    width: '760px',
    body: el('div', {}, status, grid),
    footer: el('div', { style: { display: 'flex', gap: '8px' } },
      el('button', { onclick: close }, 'Cancel'),
      el('button', {
        class: 'primary',
        onclick: () => { close(); void app.attachPage(assetId, selected, target, fileName) },
      }, 'Use this page'),
    ),
  }))

  const cards: HTMLElement[] = []
  const shown = Math.min(total, MAX_THUMBS)
  for (let page = 1; page <= shown; page++) {
    const card = el('div', { class: `page-card ${page === 1 ? 'active' : ''}` },
      el('div', { style: { height: '110px' } }),
      el('span', {}, `Page ${page}`),
    )
    card.addEventListener('click', () => {
      selected = page
      for (const c of cards) c.classList.remove('active')
      card.classList.add('active')
    })
    card.addEventListener('dblclick', () => {
      selected = page
      handle.close()
      void app.attachPage(assetId, page, target, fileName)
    })
    cards.push(card)
    grid.appendChild(card)
  }
  if (total > shown) {
    status.textContent = `${fileName} · ${total} pages (showing the first ${shown})`
  }

  // Render thumbnails one at a time so a big set does not lock the UI.
  for (let page = 1; page <= shown; page++) {
    if (!handle.element.isConnected) return
    try {
      const canvas = await renderThumbnail(assetId, base64, page, 150)
      const slot = cards[page - 1].firstElementChild
      if (slot) {
        slot.replaceWith(canvas)
      }
    } catch (err) {
      console.warn(`thumbnail for page ${page} failed`, err)
    }
  }
}
