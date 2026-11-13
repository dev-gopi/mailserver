import { Router } from "express";
import { authController } from "../controllers/auth.controller";
import { requireAdmin } from "../middleware/auth";
import { validate } from "../validation/validate";
import {
  loginSchema,
  changePasswordSchema,
  mfaVerifySchema,
  resetPasswordSchema,
  totpEnableSchema,
  passwordConfirmSchema,
  passkeyRegisterSchema,
  passkeyLoginVerifySchema
} from "../validation/schemas";

export const authRouter = Router();

// Public auth endpoints
authRouter.post(
  "/login",
  validate({ body: loginSchema }),
  authController.login
);

authRouter.post(
  "/mfa/verify",
  validate({ body: mfaVerifySchema }),
  authController.verifyMfa
);

authRouter.post(
  "/reset-password",
  validate({ body: resetPasswordSchema }),
  authController.resetPasswordWithRecovery
);

authRouter.post(
  "/passkey/login-options",
  authController.getPasskeyLoginOptions
);

authRouter.post(
  "/passkey/login-verify",
  validate({ body: passkeyLoginVerifySchema }),
  authController.verifyPasskeyLogin
);

// Protected auth & security endpoints
authRouter.get(
  "/me",
  requireAdmin,
  authController.getMe
);

authRouter.post(
  "/change-password",
  requireAdmin,
  validate({ body: changePasswordSchema }),
  authController.changePassword
);

authRouter.post(
  "/logout",
  requireAdmin,
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
  validate({ body: totpEnableSchema }),
  authController.enableTotp
);

authRouter.post(
  "/totp/disable",
  requireAdmin,
  validate({ body: passwordConfirmSchema }),
  authController.disableTotp
);

authRouter.post(
  "/totp/regenerate-recovery",
  requireAdmin,
  validate({ body: passwordConfirmSchema }),
  authController.regenerateRecoveryCodes
);

authRouter.get(
  "/passkey/register-options",
  requireAdmin,
  authController.getPasskeyRegisterOptions
);

authRouter.post(
  "/passkey/register-verify",
  requireAdmin,
  validate({ body: passkeyRegisterSchema }),
  authController.verifyPasskeyRegister
);

authRouter.delete(
  "/passkey/:id",
  requireAdmin,
  authController.removePasskey
);
