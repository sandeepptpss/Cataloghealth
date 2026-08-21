import { PrismaClient } from "@prisma/client";

function getPrismaClient() {
  if (process.env.NODE_ENV === "production") {
    if (!global.prismaGlobal) {
      global.prismaGlobal = new PrismaClient();
    }
    return global.prismaGlobal;
  }

  // Force re-instantiation if models are missing due to dev HMR
  if (
    !global.prismaGlobal ||
    !global.prismaGlobal.store ||
    !global.prismaGlobal.product ||
    !global.prismaGlobal.supportTicket
  ) {
    global.prismaGlobal = new PrismaClient();
  }

  return global.prismaGlobal;
}

const prisma = new Proxy(
  {},
  {
    get(target, prop) {
      const client = getPrismaClient();
      const value = Reflect.get(client, prop);
      if (typeof value === "function") {
        return value.bind(client);
      }
      return value;
    },
  }
);

export default prisma;
