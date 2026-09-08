/// <reference types="vite/client" />

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
