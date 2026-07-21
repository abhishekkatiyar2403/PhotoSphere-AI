"use client";

import { Suspense, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff, LockKeyhole, Mail } from "lucide-react";
import { ApiError, authApi } from "@/lib/api";
import { Ps2Logo } from "@/components/v2/Ps2Logo";
import { Ps2Brand } from "@/components/v2/Ps2Brand";
import { useIsMobile } from "@/components/v2/useIsMobile";

type AuthView = "login" | "signup" | "forgot" | "forgot-sent";

// Desktop collage tiles - positions, tilts and float timings match the
// prototype's five-tile arrangement exactly.
const DESKTOP_FLOATS: { src: string; style: CSSProperties }[] = [
  {
    src: "/v2/photos/01-dusk-alps.png",
    style: { left: "8%", top: "12%", width: "30%", aspectRatio: "4/3", "--tilt": "-5deg", animationDuration: "9s" } as CSSProperties,
  },
  {
    src: "/v2/photos/10-orchid-peak.png",
    style: { left: "42%", top: "6%", width: "24%", aspectRatio: "3/4", "--tilt": "3deg", animationDuration: "11s", animationDelay: "1.2s" } as CSSProperties,
  },
  {
    src: "/v2/photos/08-arctic-coast.png",
    style: { left: "14%", top: "52%", width: "26%", aspectRatio: "1", "--tilt": "2deg", animationDuration: "10s", animationDelay: "0.6s" } as CSSProperties,
  },
  {
    src: "/v2/photos/12-ember-canyon.png",
    style: { left: "48%", top: "46%", width: "34%", aspectRatio: "4/3", "--tilt": "-2deg", animationDuration: "12s", animationDelay: "2s" } as CSSProperties,
  },
  {
    src: "/v2/photos/03-teal-fjord.png",
    style: { left: "70%", top: "16%", width: "22%", aspectRatio: "3/4", "--tilt": "5deg", animationDuration: "9.5s", animationDelay: "3s" } as CSSProperties,
  },
];

// Prototype password strength: purely length-driven levels with fixed colors.
function passwordStrength(pw: string): { level: number; label: string; colors: string[] } {
  const len = pw.length;
  const level = len === 0 ? 0 : len < 4 ? 1 : len < 8 ? 2 : len < 12 ? 3 : 4;
  const colors = ["#e87f8f", "#e8a15c", "#e8d45c", "#7fd8a8"];
  const label = len === 0 ? "Use 8+ characters for a strong password" : len < 4 ? "Weak" : len < 8 ? "Fair" : len < 12 ? "Good" : "Strong";
  return { level, label, colors };
}

export default function LoginV2Page() {
  return (
    <Suspense fallback={null}>
      <LoginV2Screen />
    </Suspense>
  );
}

function LoginV2Screen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();

  const [view, setView] = useState<AuthView>(() => (searchParams.get("view") === "signup" ? "signup" : "login"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [forgotEmail, setForgotEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showSignupPassword, setShowSignupPassword] = useState(false);

  useEffect(() => {
    authApi
      .me()
      .then(() => router.replace("/v2/dashboard"))
      .catch(() => {
        // not authenticated - stay on the login screen, this is expected
      });
  }, [router]);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await authApi.login({ email, password });
      router.push("/v2/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignup(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await authApi.signup({ name: signupName, email: signupEmail, password: signupPassword });
      router.push("/v2/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleForgotSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // There is no /api/auth/forgot-password endpoint yet - this shows the
    // same confirmation screen as the prototype, but no email is actually
    // sent. Wire this up once a real endpoint exists.
    setView("forgot-sent");
  }

  const strength = passwordStrength(signupPassword);
  const [taglineLine1, taglineLine2] = taglineFor(view);

  return (
    <div className="ps2-auth-page">
      {isMobile ? (
        <div className="ps2-auth-mobile-hero">
          <img className="ps2-auth-mobile-hero-bg" src="/v2/photos/12-ember-canyon.png" alt="" />
          <div className="ps2-auth-mobile-hero-scrim" />
          <div
            className="ps2-auth-mobile-float"
            style={{ right: 18, top: "24%", width: 96, aspectRatio: "3/4", "--tilt": "5deg", animationDuration: "10s", animationDelay: "1s" } as CSSProperties}
          >
            <img src="/v2/photos/10-orchid-peak.png" alt="" />
          </div>
          <div
            className="ps2-auth-mobile-float"
            style={{ right: 96, top: "44%", width: 78, aspectRatio: "1", borderRadius: 13, "--tilt": "-6deg", animationDuration: "12s", animationDelay: "2.2s" } as CSSProperties}
          >
            <img src="/v2/photos/03-teal-fjord.png" alt="" />
          </div>
          <div className="ps2-auth-mobile-logo">
            <Ps2Logo size={30} gradientId="ps2LogoAuthMobile" />
            <span>PhotoSphere</span>
          </div>
          <div className="ps2-auth-mobile-tagline" key={view}>
            {taglineLine1}
            <br />
            {taglineLine2}
          </div>
        </div>
      ) : (
        <div className="ps2-auth-collage">
          <div className="ps2-auth-collage-glow" />
          {DESKTOP_FLOATS.map((f) => (
            <div key={f.src} className="ps2-auth-float" style={f.style}>
              <img src={f.src} alt="" />
            </div>
          ))}
          <div className="ps2-auth-tagline">
            <div className="ps2-auth-tagline-text" key={view}>
              {taglineLine1}
              <br />
              {taglineLine2}
            </div>
          </div>
        </div>
      )}

      <div className="ps2-auth-form-panel">
        <div className="ps2-auth-form-inner">
          <Ps2Brand variant="login" gradientId="ps2LogoAuthForm" />

          {error && <div className="ps2-auth-error">{error}</div>}

          {view === "login" && (
            <div className="ps2-auth-view login">
              <h1 className="ps2-auth-heading">Welcome back</h1>
              <p className="ps2-auth-sub login-sub">Your library is right where you left it.</p>
              <form className="ps2-auth-form" onSubmit={handleLogin}>
                <div className="ps2-auth-field">
                  <label htmlFor="ps2-login-email">Email</label>
                  <div className="ps2-auth-input-wrap">
                    <Mail className="ps2-auth-input-icon" size={19} strokeWidth={1.8} />
                    <input
                      id="ps2-login-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="Email address"
                      required
                      autoComplete="email"
                    />
                  </div>
                </div>
                <div className="ps2-auth-field">
                  <label htmlFor="ps2-login-password">Password</label>
                  <div className="ps2-auth-input-wrap">
                    <LockKeyhole className="ps2-auth-input-icon" size={19} strokeWidth={1.8} />
                    <input
                      id="ps2-login-password"
                      type={showLoginPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Password"
                      required
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      className="ps2-auth-input-eye"
                      onClick={() => setShowLoginPassword((v) => !v)}
                      aria-label={showLoginPassword ? "Hide password" : "Show password"}
                    >
                      {showLoginPassword ? <EyeOff size={19} strokeWidth={1.8} /> : <Eye size={19} strokeWidth={1.8} />}
                    </button>
                  </div>
                </div>
                <button type="submit" className="ps2-auth-submit" disabled={submitting}>
                  {submitting ? "Signing in…" : "Continue"}
                </button>
              </form>
              <div className="ps2-auth-divider">
                <span />
                <div className="ps2-auth-divider-star">✦</div>
                <span />
              </div>
              <div className="ps2-auth-links">
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setError(null);
                    setView("forgot");
                  }}
                >
                  Forgot password?
                </a>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setError(null);
                    setView("signup");
                  }}
                >
                  Create account
                </a>
              </div>
            </div>
          )}

          {view === "signup" && (
            <div className="ps2-auth-view">
              <h1 className="ps2-auth-heading">Create your sphere</h1>
              <p className="ps2-auth-sub">Your next thousand memories start here.</p>
              <form className="ps2-auth-form" onSubmit={handleSignup}>
                <div className="ps2-auth-field">
                  <label htmlFor="ps2-signup-name">Full name</label>
                  <input
                    id="ps2-signup-name"
                    value={signupName}
                    onChange={(e) => setSignupName(e.target.value)}
                    placeholder="Alex Rivera"
                    required
                    autoComplete="name"
                  />
                </div>
                <div className="ps2-auth-field">
                  <label htmlFor="ps2-signup-email">Email</label>
                  <div className="ps2-auth-input-wrap">
                    <Mail className="ps2-auth-input-icon" size={19} strokeWidth={1.8} />
                    <input
                      id="ps2-signup-email"
                      type="email"
                      value={signupEmail}
                      onChange={(e) => setSignupEmail(e.target.value)}
                      placeholder="you@example.com"
                      required
                      autoComplete="email"
                    />
                  </div>
                </div>
                <div className="ps2-auth-field">
                  <label htmlFor="ps2-signup-password">Password</label>
                  <div className="ps2-auth-input-wrap">
                    <LockKeyhole className="ps2-auth-input-icon" size={19} strokeWidth={1.8} />
                    <input
                      id="ps2-signup-password"
                      type={showSignupPassword ? "text" : "password"}
                      value={signupPassword}
                      onChange={(e) => setSignupPassword(e.target.value)}
                      placeholder="Make it a good one"
                      required
                      minLength={8}
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      className="ps2-auth-input-eye"
                      onClick={() => setShowSignupPassword((v) => !v)}
                      aria-label={showSignupPassword ? "Hide password" : "Show password"}
                    >
                      {showSignupPassword ? <EyeOff size={19} strokeWidth={1.8} /> : <Eye size={19} strokeWidth={1.8} />}
                    </button>
                  </div>
                  <div className="ps2-auth-strength">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="ps2-auth-strength-seg"
                        style={i < strength.level ? { background: strength.colors[strength.level - 1] } : undefined}
                      />
                    ))}
                  </div>
                  <div className="ps2-auth-strength-label">{strength.label}</div>
                </div>
                <button type="submit" className="ps2-auth-submit" style={{ marginTop: 6 }} disabled={submitting}>
                  {submitting ? "Creating your sphere…" : "Create account"}
                </button>
              </form>
              <div className="ps2-auth-links center">
                Already have an account?{" "}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setError(null);
                    setView("login");
                  }}
                >
                  Sign in
                </a>
              </div>
            </div>
          )}

          {view === "forgot" && (
            <div className="ps2-auth-view">
              <h1 className="ps2-auth-heading">Reset your password</h1>
              <p className="ps2-auth-sub">Enter your email and we&apos;ll send a link to get back in.</p>
              <form className="ps2-auth-form" onSubmit={handleForgotSubmit}>
                <div className="ps2-auth-field">
                  <label htmlFor="ps2-forgot-email">Email</label>
                  <div className="ps2-auth-input-wrap">
                    <Mail className="ps2-auth-input-icon" size={19} strokeWidth={1.8} />
                    <input
                      id="ps2-forgot-email"
                      type="email"
                      value={forgotEmail}
                      onChange={(e) => setForgotEmail(e.target.value)}
                      placeholder="you@example.com"
                      required
                      autoComplete="email"
                    />
                  </div>
                </div>
                <button type="submit" className="ps2-auth-submit" style={{ marginTop: 6 }}>
                  Send reset link
                </button>
              </form>
              <div className="ps2-auth-links center">
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setError(null);
                    setView("login");
                  }}
                >
                  ← Back to sign in
                </a>
              </div>
            </div>
          )}

          {view === "forgot-sent" && (
            <div className="ps2-auth-view ps2-auth-sent">
              <div className="ps2-auth-sent-icon">
                <svg width="64" height="64" viewBox="0 0 64 64">
                  <rect x="8" y="16" width="48" height="34" rx="6" fill="none" stroke="var(--ps2-accent)" strokeWidth="2.2" />
                  <path d="M10 18l22 18 22-18" fill="none" stroke="var(--ps2-accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <svg width="64" height="64" viewBox="0 0 64 64">
                  <circle cx="32" cy="32" r="26" fill="none" stroke="var(--ps2-accent)" strokeWidth="2.2" />
                  <path
                    className="ps2-auth-sent-check"
                    d="M21 33l8 8 15-17"
                    fill="none"
                    stroke="var(--ps2-accent)"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <h1 className="ps2-auth-heading sent">Check your email</h1>
              <p className="ps2-auth-sub sent-sub">
                We sent a reset link to
                <br />
                <strong style={{ color: "var(--ps2-text)", fontWeight: 600 }}>{forgotEmail || "your inbox"}</strong>
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <button type="button" className="ps2-auth-resend" onClick={() => setView("forgot-sent")}>
                  Resend link
                </button>
                <a
                  href="#"
                  style={{ fontSize: 13.5 }}
                  onClick={(e) => {
                    e.preventDefault();
                    setView("login");
                  }}
                >
                  ← Back to sign in
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function taglineFor(view: AuthView): [string, string] {
  switch (view) {
    case "signup":
      return ["Your next thousand", "memories start here."];
    case "forgot":
    case "forgot-sent":
      return ["We'll get you", "back in, in no time."];
    default:
      return ["Every photo,", "remembered beautifully."];
  }
}
