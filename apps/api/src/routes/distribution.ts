import type { FastifyInstance } from "fastify";
import { AppleDistributionBody, type AppleDistributionResponse } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import {
  createAppleAppTransactionVerifier,
  type AppleAppTransactionVerifier,
} from "../distribution/apple-app-transaction.js";

export async function distributionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/me/distribution", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = AppleDistributionBody.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, "invalid_body");
      }

      const injected = (app.fina.distribution ?? {}) as {
        appleAppTransactionVerifier?: AppleAppTransactionVerifier;
      };
      const verifier =
        injected.appleAppTransactionVerifier ??
        createAppleAppTransactionVerifier({
          ...(app.fina.env.APPLE_BUNDLE_ID ? { bundleId: app.fina.env.APPLE_BUNDLE_ID } : {}),
          ...(app.fina.env.APPLE_APP_APPLE_ID
            ? { appAppleId: app.fina.env.APPLE_APP_APPLE_ID }
            : {}),
        });
      const verified = await verifier.verify(parsed.data.signedAppTransaction);
      const signupEnvironment = verified.environment === "Production" ? "PRODUCTION" : "TEST";
      const verifiedAt = new Date();

      // First verified install wins. A tester later opening the same account
      // from the App Store (or vice versa) must not rewrite signup attribution.
      await prisma.user.updateMany({
        where: { id: session.userId, signupEnvironment: "UNKNOWN" },
        data: {
          signupEnvironment,
          signupPlatform: "ios",
          signupBuildNumber: verified.applicationVersion,
          appleStoreEnvironment: verified.environment,
          environmentVerifiedAt: verifiedAt,
        },
      });
      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        select: { signupEnvironment: true },
      });
      if (!user) throw new HttpError(404, "no_user");

      const response: AppleDistributionResponse = {
        signupEnvironment: user.signupEnvironment as "TEST" | "PRODUCTION",
        platform: "ios",
        buildNumber: verified.applicationVersion,
        storeEnvironment: verified.environment,
        verifiedAt: verifiedAt.toISOString(),
      };
      return reply.send(response);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
