"use client";

// Login v2 — redesign handoff (README.md "Login"). Same auth logic as the
// classic /login page (already-authed redirect, authApi.login, error copy),
// only restyled into the ps2 cinematic split. On success it lands on the v2
// dashboard so the new UI stays cohesive; the "Classic UI" switch links back
// to the classic /login.

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ApiError, authApi } from "@/lib/api";
import Ps2AuthShell from "@/components/ps2/AuthShell";

export default function LoginV2Page() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    authApi
      .me()
      .then(() => router.replace("/dashboard/v2"))
      .catch(() => {
        // not authenticated — stay on login, expected path
      });
  }, [router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await authApi.login({ email, password });
      router.push("/dashboard/v2");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Ps2AuthShell switchHref="/login" switchLabel="Classic UI">
      <div className="ps2-auth-title">Welcome back</div>
      <p className="ps2-auth-subtitle">Your library is right where you left it.</p>

      {error && <div className="ps2-auth-error">{error}</div>}

      <form className="ps2-auth-fields" onSubmit={handleSubmit}>
        <div className="ps2-auth-field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
        <div className="ps2-auth-field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </div>
        <button type="submit" className="ps2-auth-submit" disabled={submitting}>
          {submitting ? "Logging in…" : "Continue"}
        </button>
      </form>

      <p className="ps2-auth-footer">
        Don&apos;t have an account? <Link href="/signup/v2">Create account</Link>
      </p>
    </Ps2AuthShell>
  );
}
