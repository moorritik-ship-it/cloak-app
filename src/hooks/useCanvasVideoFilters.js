import { useEffect, useMemo, useRef, useState } from 'react'
import '@tensorflow/tfjs-backend-webgl'
import * as tf from '@tensorflow/tfjs-core'
import * as bodyPix from '@tensorflow-models/body-pix'
import * as faceLandmarksDetection from '@tensorflow-models/face-landmarks-detection'

const DEFAULT_BG_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_VIRTUAL_BG_URL) || ''

export const FILTERS = [
  { id: 'none', label: 'None' },
  { id: 'bg_blur', label: 'Background blur' },
  { id: 'bg_image', label: 'Virtual bg' },
  { id: 'dog', label: 'Dog ears' },
  { id: 'cat', label: 'Cat ears' },
  { id: 'fox', label: 'Fox ears' },
  { id: 'rabbit', label: 'Rabbit ears' },
  { id: 'vintage', label: 'Vintage' },
  { id: 'neon', label: 'Neon' },
  { id: 'bw', label: 'B&W' },
]

function cssFilterFor(id) {
  if (id === 'vintage') return 'sepia(0.55) contrast(1.05) saturate(1.15)'
  if (id === 'neon') return 'contrast(1.3) saturate(1.8) hue-rotate(18deg)'
  if (id === 'bw') return 'grayscale(1) contrast(1.15)'
  return ''
}

function needsSegmentation(id) {
  return id === 'bg_blur' || id === 'bg_image'
}

function needsFaceLandmarks(id) {
  return id === 'dog' || id === 'cat' || id === 'fox' || id === 'rabbit'
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n))
}

function drawEars(ctx, { kind, x, y, w, h }) {
  // Intentionally only ears above forehead; no face-covering overlays.
  const earW = w * 0.32
  const earH = h * 0.32
  const gap = w * 0.18
  const leftX = x - gap
  const rightX = x + gap
  const topY = y - h * 0.62

  const colors = {
    dog: { a: '#8b5a2b', b: '#f2d6b3' },
    cat: { a: '#111827', b: '#f3f4f6' },
    fox: { a: '#f97316', b: '#fff7ed' },
    rabbit: { a: '#fde68a', b: '#fff' },
  }
  const c = colors[kind] || colors.dog

  function ear(px) {
    ctx.save()
    ctx.translate(px, topY)
    ctx.beginPath()
    ctx.moveTo(0, earH)
    ctx.quadraticCurveTo(earW * 0.5, 0, earW, earH)
    ctx.closePath()
    ctx.fillStyle = c.a
    ctx.globalAlpha = 0.92
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(earW * 0.18, earH * 0.92)
    ctx.quadraticCurveTo(earW * 0.5, earH * 0.25, earW * 0.82, earH * 0.92)
    ctx.closePath()
    ctx.fillStyle = c.b
    ctx.globalAlpha = 0.82
    ctx.fill()
    ctx.restore()
  }

  ear(leftX)
  ear(rightX)
}

async function ensureTfReady() {
  if (tf.getBackend() !== 'webgl') {
    await tf.setBackend('webgl')
    await tf.ready()
  }
}

export function useCanvasVideoFilters({
  videoRef,
  canvasRef,
  enabled,
  selectedFilterId,
  virtualBgUrl,
  previewCount = 8,
}) {
  const [ready, setReady] = useState(false)
  const [previews, setPreviews] = useState([])

  const segRef = useRef(null)
  const faceRef = useRef(null)
  const bgImgRef = useRef(null)
  const lastSegAtRef = useRef(0)
  const lastFaceAtRef = useRef(0)
  const lastMaskRef = useRef(null)
  const lastFaceBoxRef = useRef(null)

  const bgUrl = useMemo(() => virtualBgUrl || DEFAULT_BG_URL, [virtualBgUrl])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!enabled) return
      try {
        await ensureTfReady()
        const seg = await bodyPix.load({
          architecture: 'MobileNetV1',
          outputStride: 16,
          multiplier: 0.75,
          quantBytes: 2,
        })
        const face = await faceLandmarksDetection.createDetector(
          faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
          { runtime: 'tfjs' },
        )
        if (cancelled) return
        segRef.current = seg
        faceRef.current = face
        setReady(true)
      } catch {
        // If TF fails, still allow basic color filters.
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])

  useEffect(() => {
    if (!bgUrl) return
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = bgUrl
    bgImgRef.current = img
  }, [bgUrl])

  useEffect(() => {
    if (!enabled) return undefined
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return undefined

    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return undefined

    let raf = 0
    let previewRaf = 0
    const previewCanvases = Array.from({ length: previewCount }, () => {
      const c = document.createElement('canvas')
      c.width = 96
      c.height = 54
      return c
    })

    const tick = async () => {
      const vw = video.videoWidth || 0
      const vh = video.videoHeight || 0
      if (vw < 2 || vh < 2) {
        raf = requestAnimationFrame(() => tick().catch(() => {}))
        return
      }

      if (canvas.width !== vw || canvas.height !== vh) {
        canvas.width = vw
        canvas.height = vh
      }

      const id = selectedFilterId
      const filterCss = cssFilterFor(id)
      const doSeg = needsSegmentation(id) && segRef.current && ready
      const doFace = needsFaceLandmarks(id) && faceRef.current && ready

      // default draw
      ctx.save()
      ctx.clearRect(0, 0, vw, vh)
      ctx.filter = filterCss
      ctx.drawImage(video, 0, 0, vw, vh)
      ctx.restore()

      const now = performance.now()

      if (doSeg) {
        const segEveryMs = 180
        if (now - lastSegAtRef.current >= segEveryMs) {
          lastSegAtRef.current = now
          try {
            const segmentation = await segRef.current.segmentPerson(video, {
              flipHorizontal: true,
              internalResolution: 'medium',
              segmentationThreshold: 0.7,
            })
            lastMaskRef.current = segmentation
          } catch {
            // ignore
          }
        }

        const mask = lastMaskRef.current
        if (mask) {
          const tmp = document.createElement('canvas')
          tmp.width = vw
          tmp.height = vh
          const tctx = tmp.getContext('2d')
          if (tctx) {
            // bodyPix mask: data is 0/1 per pixel in input resolution.
            const maskCanvas = document.createElement('canvas')
            maskCanvas.width = mask.width
            maskCanvas.height = mask.height
            const mctx = maskCanvas.getContext('2d')
            if (mctx) {
              const idata = mctx.createImageData(mask.width, mask.height)
              for (let i = 0; i < mask.data.length; i += 1) {
                const v = mask.data[i] ? 255 : 0
                idata.data[i * 4 + 0] = 255
                idata.data[i * 4 + 1] = 255
                idata.data[i * 4 + 2] = 255
                idata.data[i * 4 + 3] = v
              }
              mctx.putImageData(idata, 0, 0)

              // Foreground (person)
              tctx.clearRect(0, 0, vw, vh)
              tctx.drawImage(video, 0, 0, vw, vh)
              tctx.globalCompositeOperation = 'destination-in'
              tctx.drawImage(maskCanvas, 0, 0, vw, vh)

              // Background
              ctx.save()
              ctx.clearRect(0, 0, vw, vh)

              if (id === 'bg_image' && bgImgRef.current && bgImgRef.current.complete) {
                ctx.drawImage(bgImgRef.current, 0, 0, vw, vh)
              } else {
                ctx.filter = 'blur(12px)'
                ctx.drawImage(video, 0, 0, vw, vh)
                ctx.filter = 'none'
              }

              // cut out person hole
              ctx.globalCompositeOperation = 'destination-out'
              ctx.drawImage(maskCanvas, 0, 0, vw, vh)
              ctx.globalCompositeOperation = 'source-over'

              // draw person on top
              ctx.drawImage(tmp, 0, 0, vw, vh)
              ctx.restore()
            }
          }
        }
      }

      if (doFace) {
        const faceEveryMs = 140
        if (now - lastFaceAtRef.current >= faceEveryMs) {
          lastFaceAtRef.current = now
          try {
            const faces = await faceRef.current.estimateFaces(video, { flipHorizontal: true })
            const f0 = faces && faces[0]
            if (f0?.box) {
              lastFaceBoxRef.current = f0.box
            } else {
              lastFaceBoxRef.current = null
            }
          } catch {
            // ignore
          }
        }

        const box = lastFaceBoxRef.current
        if (box) {
          const cx = box.xMin + (box.xMax - box.xMin) / 2
          const cy = box.yMin + (box.yMax - box.yMin) / 2
          const fw = box.xMax - box.xMin
          const fh = box.yMax - box.yMin
          const kind = id
          drawEars(ctx, { kind, x: cx, y: cy, w: fw, h: fh })
        }
      }

      raf = requestAnimationFrame(() => tick().catch(() => {}))
    }

    const previewTick = () => {
      const video = videoRef.current
      if (!video) return
      const vw = video.videoWidth || 0
      const vh = video.videoHeight || 0
      if (vw < 2 || vh < 2) {
        previewRaf = requestAnimationFrame(previewTick)
        return
      }

      const next = FILTERS.map((f, idx) => {
        const c = previewCanvases[idx] || previewCanvases[0]
        const pctx = c.getContext('2d')
        if (!pctx) return { id: f.id, label: f.label, dataUrl: '' }
        pctx.save()
        pctx.clearRect(0, 0, c.width, c.height)
        pctx.filter = cssFilterFor(f.id)
        pctx.drawImage(video, 0, 0, c.width, c.height)
        pctx.restore()
        return { id: f.id, label: f.label, dataUrl: c.toDataURL('image/jpeg', 0.65) }
      })
      setPreviews(next)
      previewRaf = window.setTimeout(() => requestAnimationFrame(previewTick), 1200)
    }

    raf = requestAnimationFrame(() => tick().catch(() => {}))
    previewTick()
    return () => {
      cancelAnimationFrame(raf)
      if (typeof previewRaf === 'number') {
        try {
          clearTimeout(previewRaf)
        } catch {
          // ignore
        }
      }
    }
  }, [enabled, videoRef, canvasRef, selectedFilterId, ready, previewCount])

  return { ready, previews }
}

