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

  async verifyMfa(req: Request, res: Response) {
    try {
      const { mfaToken, code, recoveryCode } = req.body;
      const result = await authService.verifyMfa(req, mfaToken, code, recoveryCode);
      return res.json(result);
    } catch (err: any) {
      return res.status(401).json({ error: err.message || "Two-step verification failed" });
    }
  }

  async resetPasswordWithRecovery(req: Request, res: Response) {
    try {
      const { username, recoveryCode, newPassword } = req.body;
      const result = await authService.resetPasswordWithRecovery(req, username, recoveryCode, newPassword);
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Password reset failed" });
    }
  }

  async getTotpSetup(req: Request, res: Response) {
    try {
      const result = await authService.getTotpSetup(req);
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Failed to generate 2FA setup" });
    }
  }

  async enableTotp(req: Request, res: Response) {
    try {
      const { secret, code, recoveryCodes } = req.body;
      const result = await authService.enableTotp(req, secret, code, recoveryCodes);
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Failed to activate 2FA" });
    }
  }

  async disableTotp(req: Request, res: Response) {
    try {
      const { password } = req.body;
      const result = await authService.disableTotp(req, password);
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Failed to disable 2FA" });
    }
  }

  async regenerateRecoveryCodes(req: Request, res: Response) {
    try {
      const { password } = req.body;
      const result = await authService.regenerateRecoveryCodes(req, password);
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Failed to regenerate recovery codes" });
    }
  }

  async getSecurityStatus(req: Request, res: Response) {
    try {
      const result = await authService.getSecurityStatus(req);
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to load security status" });
    }
  }

  async getPasskeyRegisterOptions(req: Request, res: Response) {
    try {
      const result = await authService.getPasskeyRegisterOptions(req);
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Failed to start passkey registration" });
    }
  }

  async verifyPasskeyRegister(req: Request, res: Response) {
    try {
      const { challengeId, credential, name } = req.body;
      const result = await authService.verifyPasskeyRegister(req, challengeId, credential, name);
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Failed to verify passkey" });
    }
  }

  async getPasskeyLoginOptions(req: Request, res: Response) {
    try {
      const result = await authService.getPasskeyLoginOptions(req);
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Failed to prepare passkey login" });
    }
  }

  async verifyPasskeyLogin(req: Request, res: Response) {
    try {
      const { challengeId, credential } = req.body;
      const result = await authService.verifyPasskeyLogin(req, challengeId, credential);
      return res.json(result);
    } catch (err: any) {
      return res.status(401).json({ error: err.message || "Passkey authentication failed" });
    }
  }

  async removePasskey(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const result = await authService.removePasskey(req, id);
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Failed to remove passkey" });
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
    try {
      const profile = await authService.getCurrentProfile(req);
      return res.json(profile);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to load profile" });
    }
  }
}

export const authController = new AuthController();
