"use client";

import { type ChangeEvent, type DragEvent, useEffect, useRef, useState } from "react";
import type { DocumentRecord, UploadProgress } from "@/core/contracts";
import { Icon } from "@/components/ui/icon";
import { useFocusTrap } from "@/components/ui/use-focus-trap";
import { formatBytes } from "@/lib/format";
import { uploadDocument, uploadRuntime } from "@/runtime/services";

export function UploadModal({ onClose, onCompleted }: { onClose: () => void; onCompleted: (record: DocumentRecord) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [queue, setQueue] = useState<Record<string, UploadProgress>>({});
  const [dragging, setDragging] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);

  const items = Object.entries(queue);
  const activeCount = items.filter(([, item]) => item.status === "queued" || item.status === "uploading" || item.status === "finalizing").length;
  const allDone = items.length > 0 && items.every(([, item]) => item.status === "complete");

  // Never discard in-progress work silently: closing (button, Done or Escape)
  // while files are still transferring asks first; confirming cancels them.
  const requestClose = () => {
    if (activeCount > 0) setConfirmingClose(true);
    else onClose();
  };
  useFocusTrap(dialogRef, requestClose);

  // Warn before a reload/navigation would drop in-progress uploads.
  useEffect(() => {
    if (activeCount === 0) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [activeCount]);

  // The prompt only applies while something is still transferring.
  const showCancelPrompt = confirmingClose && activeCount > 0;
  const keepUploadingRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const promptWasShownRef = useRef(false);
  // Move focus into the prompt when it opens and back to the footer action
  // when it closes, so keyboard focus never falls out of the dialog.
  useEffect(() => {
    if (showCancelPrompt) keepUploadingRef.current?.focus();
    else if (promptWasShownRef.current) doneRef.current?.focus();
    promptWasShownRef.current = showCancelPrompt;
  }, [showCancelPrompt]);

  // One controller per upload; closing the modal (unmount) aborts every
  // in-flight upload instead of leaving orphaned transfers running. The GCS
  // adapter keeps the resumable session, so re-adding the file resumes it.
  const controllersRef = useRef(new Set<AbortController>());
  const closedRef = useRef(false);
  useEffect(() => {
    const controllers = controllersRef.current;
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  const addFiles = async (files: File[]) => {
    const accepted = files.filter((file) => /\.(pdf|xlsx|xls|docx|pptx|csv)$/i.test(file.name));
    const keyOf = (file: File) => `${file.name}-${file.size}-${file.lastModified}`;
    // Show the whole batch as queued up front, so files still waiting their
    // turn count as in-progress work for the close prompt and unload warning.
    setQueue((prev) => ({
      ...prev,
      ...Object.fromEntries(accepted.map((file) => [keyOf(file), { fileName: file.name, uploadedBytes: 0, totalBytes: file.size, percent: 0, status: "queued" as const }])),
    }));
    for (const file of accepted) {
      if (closedRef.current) return;
      const key = keyOf(file);
      const controller = new AbortController();
      controllersRef.current.add(controller);
      try {
        const result = await uploadDocument(file, { onProgress: (progress) => setQueue((prev) => ({ ...prev, [key]: progress })) }, controller.signal);
        onCompleted({ id: result.documentId, name: file.name, fund: "Classifying…", period: "Detecting…", type: "Source document", pages: 0, size: formatBytes(file.size), status: "Queued", progress: 0, uploaded: "Just now", quality: "Pending", observations: 0 });
      } catch (error) {
        // Aborted because the modal closed: stop, and do not start the rest of the queue.
        if (controller.signal.aborted) return;
        setQueue((prev) => ({ ...prev, [key]: { ...prev[key], status: "error", error: error instanceof Error ? error.message : "Upload failed" } }));
      } finally {
        controllersRef.current.delete(controller);
      }
    }
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>) => { event.preventDefault(); setDragging(false); void addFiles(Array.from(event.dataTransfer.files)); };
  const onChange = (event: ChangeEvent<HTMLInputElement>) => { void addFiles(Array.from(event.target.files || [])); event.target.value = ""; };
  return <div className="modal-backdrop"><div ref={dialogRef} className="upload-modal" role="dialog" aria-modal="true" aria-labelledby="upload-title" tabIndex={-1}>
    <div className="modal-head"><div><p className="eyebrow">SOURCE INGESTION</p><h2 id="upload-title">Upload documents</h2><p>Files are registered immediately, then processed independently by downstream modules.</p></div><button className="icon-button" onClick={requestClose} aria-label="Close upload dialog"><Icon name="close"/></button></div>
    <button type="button" className={`drop-zone ${dragging ? "dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => inputRef.current?.click()} aria-label="Choose source documents to upload"><div className="drop-icon"><Icon name="upload" size={24}/></div><strong>Drop files here, or choose files</strong><span>PDF, Excel, Word, PowerPoint or CSV · large files supported</span></button><input ref={inputRef} type="file" hidden multiple accept=".pdf,.xlsx,.xls,.docx,.pptx,.csv" onChange={onChange}/>
    <div className="upload-architecture"><Icon name="shield"/><span>Large files upload directly to Google Cloud Storage using resumable {Math.round(uploadRuntime.chunkSize / 1024 / 1024)} MB chunks; application servers do not proxy file bodies.</span><b>{uploadRuntime.mode === "mock" ? "Demo transport" : "GCS resumable"}</b></div>
    {items.length > 0 && <div className="upload-list" aria-live="polite">{items.map(([key, item]) => <div className="upload-item" key={key}><div className="file-tile pdf">{item.fileName.toLowerCase().endsWith("pdf") ? "PDF" : "DOC"}</div><div className="upload-item-main"><div><strong>{item.fileName}</strong><span>{formatBytes(item.totalBytes)} · {item.status === "complete" ? "Uploaded" : item.status === "finalizing" ? "Finalizing…" : item.status === "error" ? item.error : `${item.percent}%`}</span></div><div className="upload-progress" role="progressbar" aria-label={`Upload progress for ${item.fileName}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.percent}><span style={{width:`${item.percent}%`}}/></div></div>{item.status === "complete" ? <div className="upload-check" aria-label="Upload complete"><Icon name="check" size={15}/></div> : <span className="upload-percent">{item.percent}%</span>}</div>)}</div>}
    {showCancelPrompt
      ? <div className="modal-footer"><div role="alert"><span>{activeCount === 1 ? "1 upload is still in progress" : `${activeCount} uploads are still in progress`}</span><p>Closing cancels them. Adding the same file again resumes where it stopped.</p></div><div className="modal-footer-actions"><button className="secondary-button" onClick={onClose}>Cancel uploads</button><button ref={keepUploadingRef} className="primary-button" onClick={() => setConfirmingClose(false)}>Keep uploading</button></div></div>
      : <div className="modal-footer"><div><span>What happens next?</span><p>Register → interpret → extract → review → reconcile → publish</p></div><button ref={doneRef} className={allDone ? "primary-button" : "secondary-button"} onClick={requestClose}>{allDone ? "View documents" : "Done"}</button></div>}
  </div></div>;
}
