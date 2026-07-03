import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getExposedOtp, sendOwnerOtp, wasOtpDelivered } from "../lib/notifications";

// Offline verification for specs/guest-access-otp.md's [Developer-verified]
// ground-rule AC: "no real email/SMS/cloud provider ... the notification
// module is a one-file mock". Mirrors classification.offline.test.ts exactly:
//
// 1. Runtime: every Node network entry point reachable from userland is
//    stubbed to THROW while the mock provider "sends" an OTP — a single
//    outbound attempt anywhere in the notification path would fail this test.
// 2. Static: the notifications module is asserted to import NO network-capable
//    module and NO real-delivery SDK (twilio/sendgrid/ses/resend/nodemailer)
//    and NO JWT library.
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

  it("notification module dependency graph contains no network/real-delivery/JWT import (static check)", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../lib/notifications/index.ts"),
      "utf8",
    );
    const forbidden =
      /(?:from\s+|require\()\s*["'](?:node:)?(?:http|https|net|tls|dns|dgram|undici|axios|node-fetch|twilio|@sendgrid\/[^"']+|@aws-sdk\/client-ses|resend|nodemailer|jsonwebtoken|jose)["']/;
    expect(source).not.toMatch(forbidden);
    expect(source).not.toContain("fetch(");
  });

  it("otp helper module imports nothing network-capable (static check)", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../lib/otp.ts"), "utf8");
    const forbidden =
      /(?:from\s+|require\()\s*["'](?:node:)?(?:http|https|net|tls|dns|undici|axios|node-fetch|jsonwebtoken|jose)["']/;
    expect(source).not.toMatch(forbidden);
  });
});
