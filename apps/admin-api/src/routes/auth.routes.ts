import { Router } from "express";
import { authController } from "../controllers/auth.controller";
import { requireAdmin } from "../middleware/auth";
import { validate } from "../validation/validate";
import { loginSchema, changePasswordSchema } from "../validation/schemas";

export const authRouter = Router();

authRouter.post(
  "/login",
  validate({ body: loginSchema }),
  authController.login
);

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
