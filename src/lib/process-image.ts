export type ImageJobResult = { buffer: ArrayBuffer; bytes: number };
export function processImage(file: File, width: number, height: number, quality: number, onProgress: (stage: string, percent: number) => void): Promise<ImageJobResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/image.worker.ts', import.meta.url), { type: 'module' });
    const id = Date.now() + Math.random();
    worker.onmessage = (event: MessageEvent<any>) => {
      const data = event.data;
      if (data.id !== id) return;
      onProgress(data.stage, data.percent);
      if (data.buffer) { worker.terminate(); resolve({ buffer: data.buffer, bytes: data.bytes }); }
      else if (data.error) { worker.terminate(); reject(new Error(data.error)); }
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message || 'Image worker failed.')); };
    worker.postMessage({ id, file, width, height, quality });
  });
}
