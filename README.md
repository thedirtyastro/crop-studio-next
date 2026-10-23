# Crop Studio: Batch WebP

A client-side Next.js application for batch center-cropping images to 16:9, encoding WebP in Web Workers, reporting live progress, validating inputs, and exporting a ZIP.

## Features
- Multiple image upload, drag and drop, duplicate-selection avoidance, and non-image filtering.
- Fixed 16:9 center crop.
- Output sizes: 1920×1080, 1280×720, 960×540, or source-aware capped sizing.
- WebP quality slider and configurable 1–4 worker concurrency.
- Live per-file stage and percentage, total progress, elapsed timer, approximate ETA, queue counts, errors, input/output sizes, and process log.
- ZIP folder name validation and ZIP export using `fflate` STORE mode.
- First successful image is written twice as `banner.webp` and `01.webp`; subsequent successful images are `02.webp`, `03.webp`, etc. Failed images are skipped and successful images are renumbered without gaps.
- Images stay in the browser. No server upload or API key.

## Requirements
- Node.js 20.9+ recommended for Next.js 16.
- Current Chrome, Edge, or Firefox with module Workers and `OffscreenCanvas` support.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

To create a production build:

```bash
npm run build
npm start
```

## How the timer and progress work
- The elapsed timer measures time since batch start.
- Each file reports worker stages: decoding, cropping/resizing, and WebP encoding.
- Overall progress is the average of per-file percentages. Failed items count as failed rather than completed.
- ETA is a rough estimate based on completed-file throughput and worker count. Image dimensions vary, so it is not a guarantee.
- Output copy count is `successful source images + 1`, because the first successful output is duplicated as the banner.

## Validation and limitations
- The output folder name is required and filesystem-reserved characters are replaced with hyphens.
- Empty files and unsupported browser capabilities are rejected with a message. Non-image files are skipped on upload.
- Browser memory and device performance limit practical batch size. For very large batches, process smaller groups and try 2 workers before increasing concurrency.
- Cropping is a centered 16:9 crop, not a draggable focal-point crop editor.
- GIFs are processed as a still image, not as animation.
- The app requires a browser that supports WebP output through `OffscreenCanvas.convertToBlob()`.
