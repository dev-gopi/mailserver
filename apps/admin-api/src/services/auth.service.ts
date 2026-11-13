import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { Request } from "express";
import { env } from "../config/env";
import { adminRepository } from "../repositories/admin.repository";
import { createToken, tokenHash } from "../middleware/auth";
import { auditService } from "./audit";

export class AuthService {
  async login(req: Request, username: string, password: string) {
    const admin = await adminRepository.findByUsername(username);

    if (
      !admin ||
      (admin.locked_until && new Date(admin.locked_until) > new Date()) ||
      !(await bcrypt.compare(password, admin.password_hash))
    ) {
      if (admin) {
        await adminRepository.recordFailedLogin(admin.id);
      }
      throw new Error("Invalid administrator credentials");
    }

    const token = createToken();
    await adminRepository.recordSuccessfulLogin(admin.id);

    const sessionId = randomUUID();
    const userAgent = req.header("user-agent") || null;
    const ip = req.ip || null;

    await adminRepository.createSession(
      sessionId,
      admin.id,
      tokenHash(token),
      env.sessionHours,
      ip,
      userAgent
    );

    req.admin = {
      id: admin.id,
      username: admin.username,
      role: admin.role,
      mustChangePassword: admin.must_change_password
    };

    await auditService.log(req, "admin.login", "admin", admin.id);

    return {
      token,
      mustChangePassword: admin.must_change_password,
      expiresInSeconds: env.sessionHours * 3600,
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role
      }
    };
  }

  async changePassword(req: Request, currentPassword: string, newPassword: string) {
    const admin = await adminRepository.findById(req.admin!.id);
    if (!admin || !(await bcrypt.compare(currentPassword, admin.password_hash))) {
      throw new Error("Current password is incorrect");
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    await adminRepository.updatePassword(req.admin!.id, hashed);
    await auditService.log(req, "admin.password.change", "admin", req.admin!.id);
  }

  async logout(req: Request) {
    const rawHeader = req.header("authorization") || "";
    const token = rawHeader.replace(/^Bearer\s+/i, "");
    if (token) {
      await adminRepository.revokeSession(tokenHash(token));
      await auditService.log(req, "admin.logout", "admin", req.admin!.id);
    }
  }

  async getCurrentProfile(req: Request) {
    return { admin: req.admin };
  }
}

export const authService = new AuthService();
