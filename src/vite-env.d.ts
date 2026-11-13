/// <reference types="vite/client" />

/** The build: short git SHA, `-dirty` if built from uncommitted changes. Set in vite.config.ts. */
declare const __WARREN_RELEASE__: string

interface FilePickerAcceptType {
  description?: string
  accept: Record<string, string[]>
}

interface FileSystemWritableStream {
  write(data: string | BufferSource | Blob): Promise<void>
  close(): Promise<void>
}

interface FileSystemFileHandleLike {
  readonly name: string
  getFile(): Promise<File>
  createWritable(): Promise<FileSystemWritableStream>
}

interface Window {
  showSaveFilePicker?: (opts?: {
    suggestedName?: string
    types?: FilePickerAcceptType[]
  }) => Promise<FileSystemFileHandleLike>
  showOpenFilePicker?: (opts?: {
    multiple?: boolean
    types?: FilePickerAcceptType[]
  }) => Promise<FileSystemFileHandleLike[]>
}
