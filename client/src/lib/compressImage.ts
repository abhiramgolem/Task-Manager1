// Photos are made smaller before they are sent, as WhatsApp does.
//
// A phone photo is 3-8 MB at 4000 px. Sent as it was, it took a minute on
// mobile data, filled the server disk (the database lives on the same disk),
// and every phone that opened the chat downloaded the whole original just to
// show a 260 px bubble. 1600 px on the long side at JPEG quality 0.82 is
// indistinguishable on a phone screen and usually 200-500 KB.
//
// Left alone: anything that isn't a photo (PNG screenshots with text stay
// sharp only as PNG, so they are only resized when very large), GIFs (they'd
// lose their animation), files already small, and anything the browser can't
// decode. Any failure returns the original file — compression is never a
// reason for a photo not to be sent.

const MAX_SIDE = 1600
const QUALITY = 0.82
const SKIP_BELOW = 400 * 1024

export async function compressImage(file: File): Promise<File> {
  try {
    const type = (file.type || '').toLowerCase()
    if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/.test(type) || file.size < SKIP_BELOW) return file
    const bmp = await loadBitmap(file)
    if (!bmp) return file
    const { width: w, height: h } = bmp
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h))
    // A PNG (usually a screenshot) is only touched when it is big; text in a
    // screenshot smears under JPEG.
    if (type === 'image/png' && scale === 1 && file.size < 3 * 1024 * 1024) return file
    const cw = Math.round(w * scale), ch = Math.round(h * scale)
    const canvas = document.createElement('canvas')
    canvas.width = cw; canvas.height = ch
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.fillStyle = '#fff' // a transparent PNG would otherwise turn black as JPEG
    ctx.fillRect(0, 0, cw, ch)
    ctx.drawImage(bmp as CanvasImageSource, 0, 0, cw, ch)
    if ('close' in bmp && typeof (bmp as ImageBitmap).close === 'function') (bmp as ImageBitmap).close()
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', QUALITY))
    if (!blob || blob.size >= file.size) return file
    const name = file.name.replace(/\.(png|jpe?g|webp|heic|heif)$/i, '') + '.jpg'
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified })
  } catch {
    return file
  }
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement | null> {
  try {
    // imageOrientation respects the photo's EXIF rotation, so a portrait shot
    // doesn't arrive lying on its side.
    if (typeof createImageBitmap === 'function') return await createImageBitmap(file, { imageOrientation: 'from-image' } as any)
  } catch { /* fall back to an <img> */ }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}
