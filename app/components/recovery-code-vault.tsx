"use client";

import { Check, Copy, Download, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { formatRecoveryCodeFile, RECOVERY_CODE_FILENAME } from "@/lib/recovery-code-download";

type RecoveryCodeVaultProps = {
  codes: string[];
  continueLabel?: string;
  onContinue?: () => void;
};

export function RecoveryCodeVault({ codes, continueLabel = "I saved these codes", onContinue }: RecoveryCodeVaultProps) {
  const [savedAction, setSavedAction] = useState<"copy" | "download" | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const plainCodes = codes.join("\n");

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(plainCodes);
      setSavedAction("copy");
      setFeedback({ tone: "success", message: "All recovery codes copied." });
    } catch {
      setSavedAction(null);
      setFeedback({ tone: "error", message: "Copy failed. Download the file or save each code manually." });
    }
  }

  function downloadCodes() {
    const blob = new Blob([formatRecoveryCodeFile(codes)], { type: "text/plain;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = RECOVERY_CODE_FILENAME;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    setSavedAction("download");
    setFeedback({ tone: "success", message: "Recovery codes downloaded." });
  }

  return <>
    <ol className="recovery-code-list" aria-label="Recovery codes">
      {codes.map((code) => <li key={code}><code>{code}</code></li>)}
    </ol>
    <div className="recovery-actions" aria-label="Save recovery codes">
      <button type="button" className="button button-quiet" onClick={() => void copyCodes()}>
        {savedAction === "copy" ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />} {savedAction === "copy" ? "Copied" : "Copy all codes"}
      </button>
      <button type="button" className="button button-quiet" onClick={downloadCodes}>
        {savedAction === "download" ? <Check size={18} aria-hidden="true" /> : <Download size={18} aria-hidden="true" />} {savedAction === "download" ? "Downloaded" : "Download .txt file"}
      </button>
    </div>
    <p className="recovery-file-warning"><ShieldCheck size={18} aria-hidden="true" /><span><strong>Saved only on this device.</strong> A downloaded file is plain text. Move it to a password manager or encrypted vault, then delete it from Downloads.</span></p>
    <p className={`recovery-feedback${feedback?.tone === "error" ? " is-error" : ""}`} role={feedback?.tone === "error" ? "alert" : "status"} aria-live="polite">{feedback?.message ?? "Choose copy or download, then confirm that your codes are safe."}</p>
    {onContinue ? <button type="button" className="button button-primary button-wide" onClick={onContinue}>{continueLabel}</button> : null}
  </>;
}
