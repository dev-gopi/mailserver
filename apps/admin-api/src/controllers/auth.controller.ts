import { Request, Response } from "express";
import { authService } from "../services/auth.service";

export class AuthController {
  async login(req: Request, res: Response) {
    try {
      const { username, password } = req.body;
      const result = await authService.login(req, username, password);
      return res.json(result);
    } catch (err: any) {
      return res.status(401).json({ error: err.message || "Invalid credentials" });
    }
  }

  async changePassword(req: Request, res: Response) {
    try {
      const { currentPassword, newPassword } = req.body;
      await authService.changePassword(req, currentPassword, newPassword);
      return res.status(204).end();
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Password update failed" });
    }
  }

  async logout(req: Request, res: Response) {
    try {
      await authService.logout(req);
      return res.status(204).end();
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Logout failed" });
    }
  }

  async getMe(req: Request, res: Response) {
    const profile = await authService.getCurrentProfile(req);
    return res.json(profile);
  }
}

export const authController = new AuthController();
