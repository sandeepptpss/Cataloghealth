import { PrismaClient } from "@prisma/client";

// Reuse a single client across Vite dev-server module reloads so we don't
// exhaust the MySQL connection pool on every HMR update.
if (process.env.NODE_ENV !== "production" && !global.prismaGlobal) {
  global.prismaGlobal = new PrismaClient();
}

const prisma = global.prismaGlobal ?? new PrismaClient();

export default prisma;
