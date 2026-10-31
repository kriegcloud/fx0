'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

// An attached image's thumbnail that opens the image enlarged. History keeps only a
// small JPEG of each image, so it opens at twice its size, within the window.
export default function ImagePreview({ src, alt, className }: { src: string; alt: string; className: string }) {
  const [open, setOpen] = useState(false)
  const [width, setWidth] = useState<number>()
  return (
    <>
      <button
        type="button"
        aria-label={`View ${alt.charAt(0).toLowerCase()}${alt.slice(1)}`}
        onClick={() => setOpen(true)}
        className="block cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className={className} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby={undefined}
          onClick={() => setOpen(false)}
          className="w-auto max-w-[calc(100vw-2rem)] cursor-zoom-out border-0 bg-transparent p-0 shadow-none"
        >
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            onLoad={(event) => setWidth(event.currentTarget.naturalWidth * 2)}
            style={width ? { width } : undefined}
            className="h-auto max-h-[calc(100dvh-4rem)] max-w-full object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
