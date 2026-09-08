import './style.css'
import { App } from './app.ts'

const canvas = document.getElementById('canvas')
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('#canvas missing')

const app = new App(canvas)
void app.init()

// Handy from the devtools console while working on the app.
;(window as unknown as Record<string, unknown>).ductwork = app
