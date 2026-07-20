"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Brand, KeyRound } from "@/app/components/product";
import { RecoveryCodeVault } from "@/app/components/recovery-code-vault";
import { safeHostReturnTo } from "@/lib/host-return-to";

type Mode = "passkey" | "create" | "recovery" | "enroll";
type ApiError = { message?: string };
type Envelope<T> = { data?: T; error?: ApiError | null };

async function responseMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.clone().json().catch(() => null) as Envelope<unknown> | null;
  return body?.error?.message ?? fallback;
}

export default function HostSignInPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const passkeyReturnTo = safeHostReturnTo(searchParams.get("returnTo"));
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
      router.replace(passkeyReturnTo);
    } catch (cause) {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "That recovery code could not be verified.");
    }
  }

  async function enroll(event: FormEvent<HTMLFormElement>, publicMembership: boolean) {
    event.preventDefault(); setStatus("working"); setMessage("");
    const data = new FormData(event.currentTarget);
    const displayName = String(data.get("displayName") ?? "").trim();
    try {
      const optionsResponse = await fetch(publicMembership
        ? "/api/v1/auth/passkeys/public-registration/options"
        : "/api/v1/auth/passkeys/registration/options", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(publicMembership ? {} : { enrollmentCode: data.get("enrollmentCode") }),
          displayName,
        }),
      });
      if (!optionsResponse.ok) throw new Error(await responseMessage(optionsResponse, publicMembership
        ? "Account creation could not start."
        : "Pilot enrollment could not start."));
      const optionsBody = await optionsResponse.json() as Envelope<{
        accountId: string;
        options: Parameters<typeof startRegistration>[0]["optionsJSON"];
      }>;
      if (!optionsBody.data) throw new Error(publicMembership ? "Account creation could not start." : "Pilot enrollment could not start.");
      const credential = await startRegistration({ optionsJSON: optionsBody.data.options });
      const verification = await fetch(publicMembership
        ? "/api/v1/auth/passkeys/public-registration/verify"
        : "/api/v1/auth/passkeys/registration/verify", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: optionsBody.data.accountId, displayName, response: credential }),
      });
      if (!verification.ok) throw new Error(await responseMessage(verification, publicMembership
        ? "Your passkey account could not be created."
        : "Passkey enrollment could not be completed."));
      const result = await verification.json() as Envelope<{ recoveryCodes: string[] }>;
      if (!result.data?.recoveryCodes?.length) throw new Error("Recovery codes were not returned. Contact the pilot administrator before continuing.");
      setRecoveryCodes(result.data.recoveryCodes);
      setStatus("idle");
    } catch (cause) {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : publicMembership
        ? "Your passkey account could not be created."
        : "Pilot enrollment could not be completed.");
    }
  }

  if (recoveryCodes) {
    return <main className="auth-page"><header><Brand /></header><section className="auth-card recovery-card"><span className="gate-icon"><KeyRound /></span><p className="eyebrow">SAVE ONCE</p><h1>Your recovery codes</h1><p>These ten single-use codes will not be shown again. Save them before continuing.</p><RecoveryCodeVault codes={recoveryCodes} onContinue={() => router.replace(passkeyReturnTo)} /></section></main>;
  }

  const title = mode === "passkey" ? "Sign in or create an account" : mode === "create" ? "Create your UniJam account" : mode === "recovery" ? "Use a recovery code" : "Join the host pilot";
  const description = mode === "passkey"
    ? "Use a passkey to return instantly, or create a free account without connecting a music service."
    : mode === "create"
      ? "One device-secured passkey gives you a workspace and the ability to start rooms. Connect Spotify or Apple Music later if you choose."
      : mode === "recovery"
        ? "Each recovery code works once. Add a new passkey after signing in."
        : "Your pilot invite remains supported and is consumed only after your new passkey is verified.";
  const accountFields = <label className="field"><span>Your name</span><input name="displayName" autoComplete="name" maxLength={80} required /></label>;
  return <main className="auth-page"><header><Brand /></header><section className="auth-card"><span className="gate-icon"><KeyRound /></span><p className="eyebrow">UNIJAM ACCESS</p><h1>{title}</h1><p>{description}</p>{status === "error" && <p className="inline-error" role="alert">{message}</p>}{mode === "passkey" ? <><button className="button button-primary button-wide" onClick={() => void passkey()} disabled={status === "working"}>{status === "working" ? "Waiting for your device…" : "Continue with passkey"}</button><button className="button button-quiet button-wide" onClick={() => changeMode("create")} disabled={status === "working"}>Create free account</button><button className="text-button" onClick={() => changeMode("recovery")}>Use a recovery code</button><button className="text-button" onClick={() => changeMode("enroll")}>I have a pilot invite</button></> : mode === "create" ? <form onSubmit={(event) => void enroll(event, true)}>{accountFields}<button className="button button-primary button-wide" disabled={status === "working"}>{status === "working" ? "Securing your account…" : "Create account with passkey"}</button><button type="button" className="text-button" onClick={() => changeMode("passkey")}>Back to sign in</button></form> : mode === "recovery" ? <form onSubmit={(event) => void recover(event)}><label className="field"><span>Recovery code</span><input name="code" autoComplete="one-time-code" spellCheck="false" required /></label><button className="button button-primary button-wide" disabled={status === "working"}>{status === "working" ? "Verifying…" : "Verify recovery code"}</button><button type="button" className="text-button" onClick={() => changeMode("passkey")}>Back to sign in</button></form> : <form onSubmit={(event) => void enroll(event, false)}><label className="field"><span>Pilot invite code</span><input name="enrollmentCode" autoComplete="one-time-code" spellCheck="false" minLength={12} required /></label>{accountFields}<button className="button button-primary button-wide" disabled={status === "working"}>{status === "working" ? "Creating your passkey…" : "Create host passkey"}</button><button type="button" className="text-button" onClick={() => changeMode("passkey")}>Back to sign in</button></form>}</section></main>;
}
