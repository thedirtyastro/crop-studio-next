/// <reference lib="webworker" />
export {};
const ctx = self as DedicatedWorkerGlobalScope;
type RequestMessage = { id: number; file: File; width: number; height: number; quality: number };
ctx.onmessage = async (event: MessageEvent<RequestMessage>) => {
  const { id, file, width, height, quality } = event.data;
  let bitmap: ImageBitmap | undefined;
  try {
    ctx.postMessage({ id, stage: 'Decoding image', percent: 8 });
    bitmap = await createImageBitmap(file);
    const targetRatio = width / height;
    const sourceRatio = bitmap.width / bitmap.height;
    let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
    if (sourceRatio > targetRatio) { sw = bitmap.height * targetRatio; sx = (bitmap.width - sw) / 2; }
    else { sh = bitmap.width / targetRatio; sy = (bitmap.height - sh) / 2; }
    ctx.postMessage({ id, stage: 'Cropping and resizing', percent: 32 });
    let blob: Blob;
    if ('OffscreenCanvas' in self) {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not create image canvas.');
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
      ctx.postMessage({ id, stage: 'Encoding WebP', percent: 68 });
      blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    } else {
      throw new Error('OffscreenCanvas is not supported in this browser. Try the latest Chrome, Edge, or Firefox.');
    }
    if (blob.type !== 'image/webp') throw new Error('This browser did not encode WebP. Try an updated browser.');
    const buffer = await blob.arrayBuffer();
    ctx.postMessage({ id, stage: 'Complete', percent: 100, buffer, bytes: blob.size }, [buffer]);
  } catch (error) {
    ctx.postMessage({ id, stage: 'Error', percent: 0, error: error instanceof Error ? error.message : 'Unknown processing error' });
  } finally { bitmap?.close(); }
};
