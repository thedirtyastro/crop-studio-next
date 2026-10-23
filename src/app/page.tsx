'use client';
import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { zipSync, strToU8 } from 'fflate';
import { processImage } from '@/lib/process-image';

type Item = { id: string; file: File; status: 'Queued'|'Processing'|'Done'|'Error'; stage: string; percent: number; outputBytes?: number; error?: string };
const sizes = { '1920 × 1080': [1920,1080], '1280 × 720': [1280,720], '960 × 540': [960,540], 'Original-ish (source width)': [0,0] } as const;
const fmtTime = (s: number) => { if (!Number.isFinite(s) || s < 0) return 'Calculating…'; const sec = Math.ceil(s); return sec < 60 ? `${sec}s` : `${Math.floor(sec/60)}m ${sec%60}s`; };
const fmtBytes = (n: number) => n < 1024 ? `${n} B` : n < 1024**2 ? `${(n/1024).toFixed(1)} KB` : `${(n/1024**2).toFixed(2)} MB`;
const cleanFolder = (s: string) => s.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\.+$/g, '').slice(0, 80);

function FileThumb({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const objectUrl = URL.createObjectURL(file); setUrl(objectUrl); return () => URL.revokeObjectURL(objectUrl); }, [file]);
  return <div className="file-thumb">{url && file.type.startsWith('image/') ? <img src={url} alt="" /> : <span>IMG</span>}</div>;
}

export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  const [folder, setFolder] = useState('cropped-images');
  const [size, setSize] = useState<keyof typeof sizes>('1920 × 1080');
  const [quality, setQuality] = useState(0.88);
  const [workers, setWorkers] = useState(3);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [message, setMessage] = useState('Add images to prepare your batch.');
  const [logs, setLogs] = useState<string[]>(['Ready. Files stay on your device.']);
  const [zipBytes, setZipBytes] = useState(0);
  const [exported, setExported] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const stopRef = useRef(false);
  const outputCount = items.length ? items.length + 1 : 0;
  const doneCount = items.filter(x => x.status === 'Done').length;
  const failedCount = items.filter(x => x.status === 'Error').length;
  const overall = items.length ? Math.round(items.reduce((sum, x) => sum + x.percent, 0) / items.length) : 0;
  const totalInputBytes = useMemo(() => items.reduce((sum, x) => sum + x.file.size, 0), [items]);
  const completedOutputBytes = items.reduce((sum, x) => sum + (x.outputBytes || 0), 0);
  const eta = doneCount ? ((items.length - doneCount - failedCount) * (elapsed / Math.max(doneCount,1))) / Math.max(workers,1) : NaN;
  const validFolder = cleanFolder(folder).length > 0;

  useEffect(() => {
    if (!running || startedAt === null) return;
    const timer = window.setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 200);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);

  function addFiles(fileList: FileList | File[]) {
    const incoming = Array.from(fileList);
    const accepted = incoming.filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|avif|gif|bmp|tiff?)$/i.test(f.name));
    const rejected = incoming.length - accepted.length;
    setItems(prev => {
      const known = new Set(prev.map(x => `${x.file.name}:${x.file.size}:${x.file.lastModified}`));
      const fresh = accepted.filter(f => { const k = `${f.name}:${f.size}:${f.lastModified}`; if (known.has(k)) return false; known.add(k); return true; });
      const added = fresh.map(file => ({ id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, status: 'Queued' as const, stage: 'Waiting in queue', percent: 0 }));
      setMessage(`${added.length} image(s) added${rejected ? `, ${rejected} unsupported file(s) skipped` : ''}.`);
      setLogs(prevLogs => [`${new Date().toLocaleTimeString()} · Added ${added.length} image(s).`, ...prevLogs].slice(0, 30));
      return [...prev, ...added];
    });
    setExported(false);
  }
  function onPick(e: ChangeEvent<HTMLInputElement>) { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }
  function update(id: string, patch: Partial<Item>) { setItems(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x)); }
  function log(line: string) { setLogs(prev => [`${new Date().toLocaleTimeString()} · ${line}`, ...prev].slice(0,30)); }
  function removeItem(id: string) { if (!running) setItems(prev => prev.filter(x => x.id !== id)); }

  async function startBatch() {
    if (running) return;
    if (!items.length) { setMessage('Validation: choose at least one image first.'); return; }
    if (!validFolder) { setMessage('Validation: enter a valid output folder name.'); return; }
    if (items.some(x => x.file.size === 0)) { setMessage('Validation: one or more files are empty. Remove them and retry.'); return; }
    if (typeof Worker === 'undefined' || !('OffscreenCanvas' in window)) { setMessage('Your browser lacks required worker/canvas support. Update Chrome, Edge, or Firefox.'); return; }
    const batchStartedAt = Date.now();
    stopRef.current = false; setRunning(true); setExported(false); setZipBytes(0); setElapsed(0); setStartedAt(batchStartedAt);
    setItems(prev => prev.map(x => ({ ...x, status: 'Queued', stage: 'Waiting in queue', percent: 0, error: undefined, outputBytes: undefined })));
    setMessage('Processing images in background workers…'); log(`Batch started: ${items.length} source images, target ${size}, quality ${Math.round(quality*100)}%, ${workers} workers.`);
    const dims = sizes[size];
    const jobs = items.map((item, index) => ({ item, index }));
    let cursor = 0;
    const buffers: (ArrayBuffer | null)[] = new Array(items.length).fill(null);
    const runner = async () => {
      while (!stopRef.current) {
        const jobIndex = cursor++;
        if (jobIndex >= jobs.length) return;
        const { item } = jobs[jobIndex];
        update(item.id, { status: 'Processing', stage: 'Starting worker', percent: 2 });
        try {
          let width = dims[0], height = dims[1];
          if (width === 0) {
            const bitmap = await createImageBitmap(item.file); const sourceRatio = bitmap.width / bitmap.height;
            if (sourceRatio >= 16/9) { width = Math.min(bitmap.width, 3840); height = Math.round(width*9/16); }
            else { height = Math.min(bitmap.height, 2160); width = Math.round(height*16/9); }
            bitmap.close();
          }
          const result = await processImage(item.file, width, height, quality, (stage, percent) => update(item.id, { stage, percent, status: percent === 100 ? 'Done' : 'Processing' }));
          buffers[jobIndex] = result.buffer;
          update(item.id, { status: 'Done', stage: 'WebP ready', percent: 100, outputBytes: result.bytes });
          log(`Completed ${item.file.name} → ${fmtBytes(result.bytes)} WebP.`);
        } catch (error) {
          update(item.id, { status: 'Error', stage: 'Failed', percent: 0, error: error instanceof Error ? error.message : 'Unknown error' });
          log(`Failed ${item.file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, () => runner()));
    setRunning(false); setElapsed((Date.now() - batchStartedAt) / 1000);
    if (stopRef.current) { setMessage('Batch stopped. Completed outputs remain available for a new export.'); log('Batch stopped by user.'); return; }
    const good = buffers.filter((b): b is ArrayBuffer => b !== null);
    if (!good.length) { setMessage('No images completed successfully. Review the errors and retry.'); return; }
    try {
      setMessage('Packaging WebP files into ZIP…'); log('Creating ZIP archive.');
      const safeFolder = cleanFolder(folder);
      const archive: Record<string, Uint8Array> = {};
      good.forEach((buffer, index) => {
        const name = `${String(index + 1).padStart(2,'0')}.webp`;
        archive[`${safeFolder}/${name}`] = new Uint8Array(buffer);
        if (index === 0) archive[`${safeFolder}/banner.webp`] = new Uint8Array(buffer.slice(0));
      });
      const zipped = zipSync(archive, { level: 0 });
      const blob = new Blob([zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer], { type: 'application/zip' });
      setZipBytes(blob.size);
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${safeFolder}.zip`; anchor.click(); URL.revokeObjectURL(url);
      setExported(true); setMessage(`Done. ${good.length} image(s) processed into ${good.length + 1} WebP copies.`); log(`ZIP ready: ${good.length + 1} WebP copies, ${fmtBytes(blob.size)} archive.`);
    } catch (error) { setMessage(`ZIP creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`); log('ZIP creation failed.'); }
  }
  function stopBatch() { stopRef.current = true; setRunning(false); setMessage('Stop requested. Current worker tasks may finish before the queue halts.'); }

  return <main className="shell">
    <header className="topbar"><div className="brand"><div className="brand-icon">▧</div><div><div className="brand-name">CROP<span>STUDIO</span></div><div className="brand-sub">BATCH IMAGE ENGINE · LOCAL PROCESSING</div></div></div><div className="privacy"><span className="pulse"/> YOUR FILES STAY ON THIS DEVICE</div></header>
    <section className="hero"><div className="eyebrow">IMAGE PIPELINE / 01</div><h1>Crop once.<br/><span>Export at speed.</span></h1><p>A focused 16:9 crop-to-WebP workflow with live processing telemetry, validation, timing and a ready-to-download ZIP.</p><div className="hero-stats"><div><strong>16:9</strong><small>LOCKED ASPECT</small></div><div><strong>WEBP</strong><small>OUTPUT FORMAT</small></div><div><strong>LOCAL</strong><small>NO SERVER UPLOAD</small></div></div></section>
    <div className="layout">
      <section className="panel setup"><div className="section-heading"><div><span className="step">01</span><h2>Build your batch</h2></div><span className="muted">INPUT & CONFIG</span></div>
        <div className="dropzone" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(!running)addFiles(e.dataTransfer.files);}} onClick={()=>!running&&inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={e=>{if((e.key==='Enter'||e.key===' ')&&!running)inputRef.current?.click();}}><input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={onPick}/><div className="upload-icon">↑</div><strong>Drop images here or browse files</strong><span>JPG · PNG · WEBP · AVIF · GIF · BMP · TIFF</span><small>Duplicate selections are skipped automatically.</small></div>
        <div className="field"><label htmlFor="folder">OUTPUT FOLDER NAME</label><input id="folder" value={folder} onChange={e=>setFolder(e.target.value)} disabled={running} maxLength={80} placeholder="cropped-images"/><div className="hint">ZIP and inner folder: <b>{cleanFolder(folder)||'enter-a-name'}</b></div>{!validFolder&&<div className="error-text">Folder name is required.</div>}</div>
        <div className="field"><label htmlFor="size">OUTPUT SIZE</label><select id="size" value={size} onChange={e=>setSize(e.target.value as keyof typeof sizes)} disabled={running}>{Object.keys(sizes).map(s=><option key={s}>{s}</option>)}</select><div className="hint">Center crop, fixed 16:9 ratio. Output is resized during encoding.</div></div>
        <div className="field"><div className="range-label"><label htmlFor="quality">WEBP QUALITY</label><b>{Math.round(quality*100)}%</b></div><input id="quality" type="range" min="0.5" max="1" step="0.01" value={quality} onChange={e=>setQuality(Number(e.target.value))} disabled={running}/><div className="range-ends"><span>Smaller file</span><span>Higher detail</span></div></div>
        <div className="field"><div className="range-label"><label htmlFor="workers">PARALLEL WORKERS</label><b>{workers}</b></div><input id="workers" type="range" min="1" max="4" step="1" value={workers} onChange={e=>setWorkers(Number(e.target.value))} disabled={running}/><div className="hint">Start at 2–3. More workers can use more memory and may not be faster on every device.</div></div>
        <div className="validation"><div className="validation-title">✓ PRE-FLIGHT VALIDATION</div><div className="check-row"><span className={items.length?'check-ok':'check-pending'}>{items.length?'✓':'○'}</span><span>Image selection</span><b>{items.length ? `${items.length} file(s)` : 'Waiting'}</b></div><div className="check-row"><span className={validFolder?'check-ok':'check-pending'}>{validFolder?'✓':'!'}</span><span>Output folder</span><b>{validFolder?'Valid':'Required'}</b></div><div className="check-row"><span className="check-ok">✓</span><span>Crop ratio</span><b>16:9 fixed</b></div><div className="check-row"><span className="check-ok">✓</span><span>Output naming</span><b>banner + sequence</b></div></div>
        <button className="primary-btn" onClick={startBatch} disabled={running||!items.length||!validFolder}>{running?'PROCESSING BATCH…':'▶  PROCESS & DOWNLOAD ZIP'}</button>{running&&<button className="stop-btn" onClick={stopBatch}>Stop after current worker tasks</button>}<p className="fineprint">All image processing happens in your browser. Large files and batches use your device memory.</p>
      </section>
      <section className="right-column">
        <div className="panel telemetry"><div className="section-heading"><div><span className="step">02</span><h2>Live telemetry</h2></div><span className={`live-badge ${running?'is-live':''}`}><i/> {running?'LIVE':'STANDBY'}</span></div>
          <div className="progress-top"><div><div className="big-percent">{overall}<span>%</span></div><div className="muted">OVERALL COMPLETION</div></div><div className="timer-box"><span>ELAPSED TIME</span><strong>{fmtTime(elapsed)}</strong><small>ETA: {running?fmtTime(eta):'—'}</small></div></div><div className="progress-track"><div className="progress-fill" style={{width:`${overall}%`}}/></div><div className="metrics-grid"><div className="metric"><span>QUEUED</span><strong>{items.filter(x=>x.status==='Queued').length}</strong></div><div className="metric"><span>PROCESSING</span><strong>{items.filter(x=>x.status==='Processing').length}</strong></div><div className="metric"><span>COMPLETED</span><strong>{doneCount}</strong></div><div className="metric"><span>FAILED</span><strong className={failedCount?'red':''}>{failedCount}</strong></div></div><div className="message-bar"><span className="message-dot"/>{message}</div>
          <div className="section-heading compact"><div><span className="step">03</span><h2>Output estimate</h2></div><span className="muted">LIVE COUNTS</span></div><div className="output-grid"><div><span>SOURCE IMAGES</span><strong>{items.length}</strong></div><div><span>EXPECTED WEBP COPIES</span><strong>{outputCount}</strong><small>+1 banner duplicate</small></div><div><span>FINISHED WEBP COPIES</span><strong>{doneCount ? doneCount + (items.findIndex(x=>x.status==='Done')>=0?1:0) : 0}</strong><small>Includes banner when first image succeeds</small></div><div><span>INPUT SIZE</span><strong>{fmtBytes(totalInputBytes)}</strong><small>Output so far: {fmtBytes(completedOutputBytes)}</small></div></div>
          {exported&&<div className="success-card"><span>✓</span><div><b>ZIP downloaded successfully</b><small>Archive size: {fmtBytes(zipBytes)} · {outputCount} expected WebP copies</small></div></div>}
        </div>
        <div className="panel queue-panel"><div className="section-heading"><div><span className="step">04</span><h2>Processing queue</h2></div><div className="queue-actions"><span className="muted">{items.length} TOTAL</span><button className="text-btn" onClick={()=>{if(!running){setItems([]);setMessage('Queue cleared.');setLogs(['Queue cleared.']);setExported(false);}}} disabled={running||!items.length}>Clear</button></div></div>
          {!items.length?<div className="empty-state"><div>▤</div><b>Your queue is empty</b><span>Add image files to see validation, per-file progress and errors here.</span></div>:<div className="queue-list">{items.map((item,index)=><div className="queue-item" key={item.id}><FileThumb file={item.file} /><div className="file-info"><div className="file-name" title={item.file.name}>{String(index+1).padStart(2,'0')} · {item.file.name}</div><div className="file-meta">{fmtBytes(item.file.size)} · {item.stage}</div><div className="mini-track"><div style={{width:`${item.percent}%`}}/></div>{item.error&&<div className="error-text">{item.error}</div>}</div><div className="file-status"><span className={`status status-${item.status.toLowerCase()}`}>{item.status}</span><b>{item.percent}%</b>{!running&&<button title="Remove image" className="remove-btn" onClick={()=>removeItem(item.id)}>×</button>}</div></div>)}</div>}
        </div>
        <div className="panel logs-panel"><div className="section-heading"><div><span className="step">05</span><h2>Process log</h2></div><span className="muted">LATEST FIRST</span></div><div className="logs">{logs.map((line,i)=><div key={`${line}-${i}`}><span>›</span> {line}</div>)}</div><div className="naming-note"><b>OUTPUT RULE</b><code>{cleanFolder(folder)||'folder'}/banner.webp</code><code>{cleanFolder(folder)||'folder'}/01.webp</code><code>{cleanFolder(folder)||'folder'}/02.webp …</code><p>The first successfully processed image is duplicated as <b>banner.webp</b> and <b>01.webp</b>. Remaining successful images keep their original queue order. Failed images are skipped in the ZIP.</p></div></div>
      </section>
    </div>
    <footer> CROP STUDIO <span>·</span> CLIENT-SIDE IMAGE ENGINE <span>·</span> BUILT FOR BATCH WORKFLOWS</footer>
  </main>;
}
