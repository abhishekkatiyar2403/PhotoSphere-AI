import { PrismaClient } from "@prisma/client";

// Single shared Prisma client instance across the app (and across
// tsx watch reloads in dev, via a global cache to avoid exhausting
// Postgres connections).
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV === "development") {
  global.__prisma = prisma;
}
