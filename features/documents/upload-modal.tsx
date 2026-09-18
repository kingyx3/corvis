"use client";

import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import type { DocumentRecord, UploadProgress } from "@/core/contracts";
import { Icon } from "@/components/ui/icon";
import { formatBytes } from "@/lib/format";
import { uploadDocument, uploadRuntime } from "@/runtime/services";

export function UploadModal({ onClose, onCompleted }: { onClose: () => void; onCompleted: (record: DocumentRecord) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<Record<string, UploadProgress>>({});
  const [dragging, setDragging] = useState(false);

  const addFiles = async (files: File[]) => {
    const accepted = files.filter((file) => /\.(pdf|xlsx|xls|docx|pptx|csv)$/i.test(file.name));
    for (const file of accepted) {
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      setQueue((prev) => ({ ...prev, [key]: { fileName: file.name, uploadedBytes: 0, totalBytes: file.size, percent: 0, status: "queued" } }));
      try {
        const result = await uploadDocument(file, { onProgress: (progress) => setQueue((prev) => ({ ...prev, [key]: progress })) });
        onCompleted({ id: result.documentId, name: file.name, fund: "Classifying…", period: "Detecting…", type: "Source document", pages: 0, size: formatBytes(file.size), status: "Queued", progress: 0, uploaded: "Just now", quality: "Pending", observations: 0 });
      } catch (error) {
        setQueue((prev) => ({ ...prev, [key]: { ...prev[key], status: "error", error: error instanceof Error ? error.message : "Upload failed" } }));
      }
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); void addFiles(Array.from(event.dataTransfer.files)); };
  const onChange = (event: ChangeEvent<HTMLInputElement>) => { void addFiles(Array.from(event.target.files || [])); event.target.value = ""; };
  const items = Object.entries(queue);
  const allDone = items.length > 0 && items.every(([, item]) => item.status === "complete");

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="upload-modal">
    <div className="modal-head"><div><p className="eyebrow">SOURCE INGESTION</p><h2>Upload documents</h2><p>Files are registered immediately, then processed independently by downstream modules.</p></div><button className="icon-button" onClick={onClose}><Icon name="close"/></button></div>
    <div className={`drop-zone ${dragging ? "dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => inputRef.current?.click()}><div className="drop-icon"><Icon name="upload" size={24}/></div><strong>Drop files here, or choose files</strong><span>PDF, Excel, Word, PowerPoint or CSV · large files supported</span><input ref={inputRef} type="file" hidden multiple accept=".pdf,.xlsx,.xls,.docx,.pptx,.csv" onChange={onChange}/></div>
    <div className="upload-architecture"><Icon name="shield"/><span>Large files upload directly to encrypted object storage in resumable {Math.round(uploadRuntime.partSize / 1024 / 1024)} MB parts.</span><b>{uploadRuntime.mode === "mock" ? "Demo transport" : "Secure transport"}</b></div>
    {items.length > 0 && <div className="upload-list">{items.map(([key, item]) => <div className="upload-item" key={key}><div className="file-tile pdf">{item.fileName.toLowerCase().endsWith("pdf") ? "PDF" : "DOC"}</div><div className="upload-item-main"><div><strong>{item.fileName}</strong><span>{formatBytes(item.totalBytes)} · {item.status === "complete" ? "Uploaded" : item.status === "finalizing" ? "Finalizing…" : item.status === "error" ? item.error : `${item.percent}%`}</span></div><div className="upload-progress"><span style={{width:`${item.percent}%`}}/></div></div>{item.status === "complete" ? <div className="upload-check"><Icon name="check" size={15}/></div> : <span className="upload-percent">{item.percent}%</span>}</div>)}</div>}
    <div className="modal-footer"><div><span>What happens next?</span><p>Register → interpret → extract → review → reconcile → publish</p></div><button className={allDone ? "primary-button" : "secondary-button"} onClick={onClose}>{allDone ? "View documents" : "Done"}</button></div>
  </div></div>;
}
