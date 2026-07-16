"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Brand, CopyButton, KeyRound } from "@/app/components/product";

type Mode = "passkey" | "recovery" | "enroll";
type ApiError = { message?: string };
type Envelope<T> = { data?: T; error?: ApiError | null };

async function responseMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.clone().json().catch(() => null) as Envelope<unknown> | null;
  return body?.error?.message ?? fallback;
}

export default function HostSignInPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedReturn = searchParams.get("returnTo") ?? "";
  const passkeyReturnTo = /^\/room\/[A-Za-z0-9]{6,16}$/.test(requestedReturn) ? requestedReturn : "/host";
  const [mode, setMode] = useState<Mode>("passkey");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  function changeMode(next: Mode) {
    setMode(next);
    setStatus("idle");
    setMessage("");
  }

  async function passkey() {
    setStatus("working"); setMessage("");
    try {
      const optionsResponse = await fetch("/api/v1/auth/passkeys/authentication/options", { method: "POST", credentials: "include" });
      if (!optionsResponse.ok) throw new Error(await responseMessage(optionsResponse, "Passkey sign-in could not start."));
      const optionsBody = await optionsResponse.json() as Envelope<Parameters<typeof startAuthentication>[0]["optionsJSON"]>;
      if (!optionsBody.data) throw new Error("Passkey sign-in could not start.");
      const credential = await startAuthentication({ optionsJSON: optionsBody.data });
      const verification = await fetch("/api/v1/auth/passkeys/authentication/verify", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: credential }),
      });
      if (!verification.ok) throw new Error(await responseMessage(verification, "Host access could not be verified."));
      router.replace(passkeyReturnTo);
    } catch (cause) {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "Host access could not be verified.");
    }
  }

  async function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setStatus("working"); setMessage("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/v1/auth/recovery", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: data.get("code") }),
      });
      if (!response.ok) throw new Error(await responseMessage(response, "That recovery code could not be verified."));
      router.replace("/host");
    } catch (cause) {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "That recovery code could not be verified.");
    }
  }

  async function enroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setStatus("working"); setMessage("");
    const data = new FormData(event.currentTarget);
    const displayName = String(data.get("displayName") ?? "").trim();
    try {
      const optionsResponse = await fetch("/api/v1/auth/passkeys/registration/options", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollmentCode: data.get("enrollmentCode"),
          userName: data.get("userName"),
          displayName,
        }),
      });
      if (!optionsResponse.ok) throw new Error(await responseMessage(optionsResponse, "Pilot enrollment could not start."));
      const optionsBody = await optionsResponse.json() as Envelope<{
        accountId: string;
        options: Parameters<typeof startRegistration>[0]["optionsJSON"];
      }>;
      if (!optionsBody.data) throw new Error("Pilot enrollment could not start.");
      const credential = await startRegistration({ optionsJSON: optionsBody.data.options });
      const verification = await fetch("/api/v1/auth/passkeys/registration/verify", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: optionsBody.data.accountId, displayName, response: credential }),
      });
      if (!verification.ok) throw new Error(await responseMessage(verification, "Passkey enrollment could not be completed."));
      const result = await verification.json() as Envelope<{ recoveryCodes: string[] }>;
      if (!result.data?.recoveryCodes?.length) throw new Error("Recovery codes were not returned. Contact the pilot administrator before continuing.");
      setRecoveryCodes(result.data.recoveryCodes);
      setStatus("idle");
    } catch (cause) {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "Pilot enrollment could not be completed.");
    }
  }

  if (recoveryCodes) {
    return <main className="auth-page"><header><Brand /></header><section className="auth-card recovery-card"><span className="gate-icon"><KeyRound /></span><p className="eyebrow">SAVE ONCE</p><h1>Your recovery codes</h1><p>These ten single-use codes will not be shown again. Store them in a password manager before continuing.</p><ol className="recovery-code-list" aria-label="Recovery codes">{recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ol><CopyButton value={recoveryCodes.join("\n")}>Copy all codes</CopyButton><button className="button button-primary button-wide" onClick={() => router.replace("/host")}>I saved these codes</button></section></main>;
  }

  const title = mode === "passkey" ? "Use your passkey" : mode === "recovery" ? "Use a recovery code" : "Join the host pilot";
  return <main className="auth-page"><header><Brand /></header><section className="auth-card"><span className="gate-icon"><KeyRound /></span><p className="eyebrow">HOST ACCESS</p><h1>{title}</h1><p>{mode === "passkey" ? "Your device confirms it’s you. No password is sent or stored." : mode === "recovery" ? "Each recovery code works once. Add a new passkey after signing in." : "Enrollment is invite-only. Your pilot code is consumed only after your new passkey is verified."}</p>{status === "error" && <p className="inline-error" role="alert">{message}</p>}{mode === "passkey" ? <><button className="button button-primary button-wide" onClick={() => void passkey()} disabled={status === "working"}>{status === "working" ? "Waiting for your device…" : "Continue with passkey"}</button><button className="text-button" onClick={() => changeMode("recovery")}>Use a recovery code</button><button className="text-button" onClick={() => changeMode("enroll")}>I have a pilot invite</button></> : mode === "recovery" ? <form onSubmit={(event) => void recover(event)}><label className="field"><span>Recovery code</span><input name="code" autoComplete="one-time-code" spellCheck="false" required /></label><button className="button button-primary button-wide" disabled={status === "working"}>{status === "working" ? "Verifying…" : "Verify recovery code"}</button><button type="button" className="text-button" onClick={() => changeMode("passkey")}>Back to passkey</button></form> : <form onSubmit={(event) => void enroll(event)}><label className="field"><span>Pilot invite code</span><input name="enrollmentCode" autoComplete="one-time-code" spellCheck="false" minLength={12} required /></label><label className="field"><span>Email or account name</span><input name="userName" autoComplete="username webauthn" maxLength={254} required /></label><label className="field"><span>Display name</span><input name="displayName" autoComplete="name" maxLength={80} required /></label><button className="button button-primary button-wide" disabled={status === "working"}>{status === "working" ? "Creating your passkey…" : "Create host passkey"}</button><button type="button" className="text-button" onClick={() => changeMode("passkey")}>Back to sign in</button></form>}</section></main>;
}
