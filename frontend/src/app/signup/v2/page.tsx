"use client";

// Signup v2 — redesign handoff (README.md "Login" styling, signup variant).
// Same auth logic as the classic /signup page (already-authed redirect,
// authApi.signup, 8-char minimum, error copy), restyled into the ps2
// cinematic split. Lands on the v2 dashboard on success.

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ApiError, authApi } from "@/lib/api";
import Ps2AuthShell from "@/components/ps2/AuthShell";

export default function SignupV2Page() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    authApi
      .me()
      .then(() => router.replace("/dashboard/v2"))
      .catch(() => {
        // not authenticated — stay on signup, expected path
      });
  }, [router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await authApi.signup({ name, email, password });
      router.push("/dashboard/v2");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Ps2AuthShell switchHref="/signup" switchLabel="Classic UI">
      <div className="ps2-auth-title">Create your account</div>
      <p className="ps2-auth-subtitle">Start organizing your photos, beautifully.</p>

      {error && <div className="ps2-auth-error">{error}</div>}

      <form className="ps2-auth-fields" onSubmit={handleSubmit}>
        <div className="ps2-auth-field">
          <label htmlFor="name">Name</label>
          <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
        </div>
        <div className="ps2-auth-field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
        <div className="ps2-auth-field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
        </div>
        <button type="submit" className="ps2-auth-submit" disabled={submitting}>
          {submitting ? "Creating account…" : "Create account"}
        </button>
      </form>

      <p className="ps2-auth-footer">
        Already have an account? <Link href="/login/v2">Log in</Link>
      </p>
    </Ps2AuthShell>
  );
}
