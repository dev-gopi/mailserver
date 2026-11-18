import { Router } from "express";
import { authController } from "../controllers/auth.controller";
import { rejectCrossSiteRequest, requireAdmin, requireCsrf } from "../middleware/auth";
import { validate } from "../validation/validate";
import {
  loginSchema,
  changePasswordSchema,
  mailboxChangePasswordSchema,
  mfaVerifySchema,
  resetPasswordSchema,
  totpEnableSchema,
  passwordConfirmSchema,
  passkeyRegisterSchema,
  passkeyLoginVerifySchema,
  sessionIdParamSchema
} from "../validation/schemas";

export const authRouter = Router();

// Public auth endpoints
authRouter.post(
  "/login",
  rejectCrossSiteRequest,
  validate({ body: loginSchema }),
  authController.login.bind(authController)
);

authRouter.post(
  "/mfa/verify",
  rejectCrossSiteRequest,
  validate({ body: mfaVerifySchema }),
  authController.verifyMfa.bind(authController)
);

authRouter.post(
  "/reset-password",
  rejectCrossSiteRequest,
  validate({ body: resetPasswordSchema }),
  authController.resetPasswordWithRecovery
);

authRouter.post(
  "/passkey/login-options",
  rejectCrossSiteRequest,
  authController.getPasskeyLoginOptions
);

authRouter.post(
  "/passkey/login-verify",
  rejectCrossSiteRequest,
  validate({ body: passkeyLoginVerifySchema }),
  authController.verifyPasskeyLogin.bind(authController)
);

authRouter.post(
  "/mailbox/change-password",
  rejectCrossSiteRequest,
  validate({ body: mailboxChangePasswordSchema }),
  authController.changeMailboxPassword.bind(authController)
);

// Protected auth & security endpoints
authRouter.get(
  "/me",
  requireAdmin,
  authController.getMe
);

authRouter.get("/sessions", requireAdmin, authController.listSessions);
authRouter.post("/sessions/revoke-others", requireAdmin, requireCsrf, authController.revokeOtherSessions);
authRouter.delete("/sessions/:id", requireAdmin, requireCsrf, validate({ params: sessionIdParamSchema }), authController.revokeSession);

authRouter.post(
  "/change-password",
  requireAdmin,
  requireCsrf,
  validate({ body: changePasswordSchema }),
  authController.changePassword
);

authRouter.post(
  "/logout",
  requireAdmin,
  requireCsrf,
  authController.logout
);

authRouter.get(
  "/security-status",
  requireAdmin,
  authController.getSecurityStatus
);

authRouter.get(
  "/totp/setup",
  requireAdmin,
  authController.getTotpSetup
);

authRouter.post(
  "/totp/enable",
  requireAdmin,
  requireCsrf,
  validate({ body: totpEnableSchema }),
  authController.enableTotp
);

authRouter.post(
  "/totp/disable",
  requireAdmin,
  requireCsrf,
  validate({ body: passwordConfirmSchema }),
  authController.disableTotp
);

authRouter.post(
  "/totp/regenerate-recovery",
  requireAdmin,
  requireCsrf,
  validate({ body: passwordConfirmSchema }),
  authController.regenerateRecoveryCodes
);

authRouter.post(
  "/passkey/register-options",
  requireAdmin,
  requireCsrf,
  authController.getPasskeyRegisterOptions
);

authRouter.post(
  "/passkey/register-verify",
  requireAdmin,
  requireCsrf,
  validate({ body: passkeyRegisterSchema }),
  authController.verifyPasskeyRegister
);

authRouter.delete(
  "/passkey/:id",
  requireAdmin,
  requireCsrf,
  authController.removePasskey
);
