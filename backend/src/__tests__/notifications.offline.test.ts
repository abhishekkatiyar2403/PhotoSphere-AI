import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getExposedOtp, sendOwnerOtp, wasOtpDelivered } from "../lib/notifications";

// Offline verification for the notification module's MOCK path — the
// default, unconfigured behavior (no RESEND_API_KEY/GMAIL_USER set) must
// still be 100% network-free, exactly as it always was. Two real providers
// were added deliberately (Abhishek's explicit go-ahead): a Resend-backed one
// (plain `fetch`, no SDK) and a Gmail SMTP one (`nodemailer`, needed since
// Gmail has no plain-HTTP send API) — Gmail sends to any recipient, unlike
// Resend's sandbox sender which is restricted to the account owner's own
// inbox until a real domain is verified. Both activate only when their own
// env vars are set, so this file no longer bans `fetch`/`nodemailer` from the
// module outright (that would now be a false failure); instead it proves the
// MOCK class itself still never touches the network, and that JWT/other
// unreviewed network SDKs are still absent.
//
// 1. Runtime: every Node network entry point reachable from userland is
//    stubbed to THROW while the mock provider "sends" an OTP (with
//    RESEND_API_KEY unset in this test env, so the mock is guaranteed to be
//    the active provider) — a single outbound attempt anywhere in that path
//    would fail this test.
// 2. Static: the MockNotificationProvider class body specifically (not the
//    whole file, which now legitimately has a gated real-provider class) is
//    asserted to contain no network call.
//
// This file needs no DB/MinIO/worker — it runs everywhere.

const networkDisabled = () => {
  throw new Error("Network access attempted during offline notification test");
};

beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(networkDisabled);
  vi.spyOn(http, "request").mockImplementation(networkDisabled);
  vi.spyOn(http, "get").mockImplementation(networkDisabled);
  vi.spyOn(https, "request").mockImplementation(networkDisabled);
  vi.spyOn(https, "get").mockImplementation(networkDisabled);
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(networkDisabled);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("mock notification provider works fully offline (no network, no real delivery)", () => {
  it("sendOwnerOtp completes with every network entry point disabled and records the delivery", async () => {
    const requestId = "offline-test-request-1";
    await expect(
      sendOwnerOtp({
        ownerEmail: "owner@example.com",
        ownerName: "Owner",
        guestEmail: "guest@example.com",
        code: "654321",
        requestId,
      }),
    ).resolves.toBeUndefined();

    expect(wasOtpDelivered(requestId)).toBe(true);
    // Under NODE_ENV=test the plaintext is exposed (Tester surface).
    expect(getExposedOtp(requestId)).toBe("654321");
  });

  it("notification module imports no JWT library, and the MOCK provider class body makes no network call (static check)", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../lib/notifications/index.ts"),
      "utf8",
    );
    // Still fully banned everywhere in the file: JWT libraries (never used
    // for sessions in this app) and lower-level network/SDK imports that
    // would indicate something OTHER than the two deliberate, gated real
    // providers (Resend's plain-fetch HTTP call, Gmail's nodemailer SMTP
    // client) is reaching for the network. `node:dns` is also deliberately
    // allowed here — GmailNotificationProvider uses dns.setDefaultResultOrder
    // to force IPv4-first resolution (some networks route smtp.gmail.com's
    // IPv6 address to an unreachable address), not to open its own sockets.
    const forbidden =
      /(?:from\s+|require\()\s*["'](?:node:)?(?:http|https|net|tls|dgram|undici|axios|node-fetch|twilio|@sendgrid\/[^"']+|@aws-sdk\/client-ses|resend|jsonwebtoken|jose)["']/;
    expect(source).not.toMatch(forbidden);

    // The MOCK class specifically (extracted by its own body) must remain
    // network-free — this is the class actually active by default.
    const mockClassMatch = source.match(/class MockNotificationProvider[\s\S]*?\n}/);
    expect(mockClassMatch).not.toBeNull();
    expect(mockClassMatch![0]).not.toContain("fetch(");
  });

  it("otp helper module imports nothing network-capable (static check)", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../lib/otp.ts"), "utf8");
    const forbidden =
      /(?:from\s+|require\()\s*["'](?:node:)?(?:http|https|net|tls|dns|undici|axios|node-fetch|jsonwebtoken|jose)["']/;
    expect(source).not.toMatch(forbidden);
  });
});
