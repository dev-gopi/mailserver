import bcrypt from "bcryptjs";
import { randomUUID, randomBytes } from "crypto";
import { Request } from "express";
import { env } from "../config/env";
import { adminRepository } from "../repositories/admin.repository";
import { createToken, tokenHash } from "../middleware/auth";
import { auditService } from "./audit";
import { totpService } from "./totp.service";
import { PasskeyCredential } from "../models/entities";
import { decryptSecret, encryptSecret } from "../utils/secret-crypto";

interface MfaPendingSession {
  adminId: number;
  username: string;
  expiresAt: number;
}

interface PasskeyPendingChallenge {
  challenge: string;
  adminId?: number;
  expiresAt: number;
}

export class AuthService {
  private mfaPendingSessions = new Map<string, MfaPendingSession>();
  private passkeyChallenges = new Map<string, PasskeyPendingChallenge>();

  private getWebAuthnRpId(req: Request): string {
    const origin = req.header("origin");
    const forwardedHost = req.header("x-forwarded-host")?.split(",")[0].trim();
    const hostHeader = forwardedHost || req.header("host") || req.hostname;
    let requestHostname = req.hostname.split(":")[0].toLowerCase();

    try {
      requestHostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    } catch {
      // Fall back to Express' parsed hostname for malformed or absent host headers.
    }

    if (origin) {
      try {
        requestHostname = new URL(origin).hostname.toLowerCase();
      } catch {
        // Fall back to the host supplied by Express for malformed or absent Origin headers.
      }
    }

    const configuredRpId = env.webauthnRpId.trim().toLowerCase();
    if (
      configuredRpId &&
      (configuredRpId === requestHostname || requestHostname.endsWith(`.${configuredRpId}`))
    ) {
      return configuredRpId;
    }

    return requestHostname;
  }

  private cleanupExpiredSessions() {
    const now = Date.now();
    for (const [key, session] of this.mfaPendingSessions.entries()) {
      if (session.expiresAt <= now) this.mfaPendingSessions.delete(key);
    }
    for (const [key, ch] of this.passkeyChallenges.entries()) {
      if (ch.expiresAt <= now) this.passkeyChallenges.delete(key);
    }
  }

  async login(req: Request, username: string, password: string) {
    this.cleanupExpiredSessions();
    const admin = await adminRepository.findByUsername(username);

    if (
      !admin ||
      (admin.locked_until && new Date(admin.locked_until) > new Date()) ||
      !(await bcrypt.compare(password, admin.password_hash))
    ) {
      if (admin) {
        await adminRepository.recordFailedLogin(admin.id);
      }
      const isLocked = Boolean(admin && admin.locked_until && new Date(admin.locked_until) > new Date());
      const failReason = isLocked
        ? "Account temporarily locked due to failed login attempts"
        : !admin
        ? `Username "${username}" not found`
        : "Invalid administrator password";

      await auditService.log(req, "admin.login.failed", "admin", admin ? admin.id : undefined, {
        attemptedUsername: username,
        reason: failReason,
        error: "Authentication failed",
        clientIp: req.ip || null
      });

      throw new Error(isLocked ? "Account is temporarily locked. Try again later." : "Invalid administrator credentials");
    }

    // Check if Two-Factor Authentication (TOTP) is enabled for this admin
    if (admin.totp_enabled && admin.totp_secret) {
      const mfaToken = randomUUID();
      this.mfaPendingSessions.set(mfaToken, {
        adminId: admin.id,
        username: admin.username,
        expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes validity
      });

      return {
        mfaRequired: true,
        mfaToken,
        mfaType: "totp" as const,
        username: admin.username,
        message: "Two-step verification code required"
      };
    }

    return this.finalizeSuccessfulLogin(req, admin, "password");
  }

  async verifyMfa(req: Request, mfaToken: string, code?: string, recoveryCode?: string) {
    this.cleanupExpiredSessions();
    const pending = this.mfaPendingSessions.get(mfaToken);
    if (!pending || pending.expiresAt < Date.now()) {
      this.mfaPendingSessions.delete(mfaToken);
      throw new Error("Verification session expired. Please sign in again.");
    }

    const admin = await adminRepository.findById(pending.adminId);
    if (!admin || !admin.active) {
      this.mfaPendingSessions.delete(mfaToken);
      throw new Error("Administrator account is inactive or not found");
    }

    if (code) {
      const isValid = totpService.verifyTotp(code, decryptSecret(admin.totp_secret || ""));
      if (!isValid) {
        await adminRepository.recordFailedLogin(admin.id);
        await auditService.log(req, "admin.mfa.failed", "admin", admin.id, {
          username: admin.username,
          method: "totp",
          reason: "Invalid 6-digit TOTP code"
        });
        throw new Error("Invalid 6-digit verification code. Please check your authenticator app.");
      }
    } else if (recoveryCode) {
      const consumed = await adminRepository.consumeRecoveryCode(admin.id, recoveryCode);
      if (!consumed) {
        await adminRepository.recordFailedLogin(admin.id);
        await auditService.log(req, "admin.mfa.failed", "admin", admin.id, {
          username: admin.username,
          method: "recovery_code",
          reason: "Invalid or already consumed recovery code"
        });
        throw new Error("Invalid or previously used recovery code.");
      }
    } else {
      throw new Error("Either 6-digit code or emergency recovery code is required.");
    }

    this.mfaPendingSessions.delete(mfaToken);
    return this.finalizeSuccessfulLogin(req, admin, recoveryCode ? "recovery_code" : "totp");
  }

  private async finalizeSuccessfulLogin(req: Request, admin: any, authMethod: string) {
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

    await auditService.log(req, "admin.login", "admin", admin.id, { authMethod });

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

  async resetPasswordWithRecovery(req: Request, username: string, recoveryCode: string, newPassword: string) {
    if (!newPassword || newPassword.length < 12) {
      throw new Error("New password must be at least 12 characters");
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    const resetOk = await adminRepository.resetPasswordWithRecovery(username, recoveryCode, hashed);
    if (!resetOk) {
      await auditService.log(req, "admin.password.reset.failed", "admin", undefined, {
        username,
        reason: "Invalid recovery code or username"
      });
      throw new Error("Invalid username or recovery code. Please verify credentials.");
    }

    await auditService.log(req, "admin.password.reset.recovery", "admin", undefined, { username });
    return { message: "Administrator password successfully reset. You can now sign in." };
  }

  async getTotpSetup(req: Request) {
    const admin = await adminRepository.findById(req.admin!.id);
    if (!admin) throw new Error("Admin not found");

    const secret = totpService.generateSecret();
    const uri = totpService.generateUri(secret, admin.username);
    const qrSvg = await totpService.generateQrSvg(uri);
    const recoveryCodes = totpService.generateRecoveryCodes(8);

    return {
      secret,
      uri,
      qrSvg,
      recoveryCodes
    };
  }

  async enableTotp(req: Request, secret: string, code: string, recoveryCodes: string[]) {
    const isValid = totpService.verifyTotp(code, secret);
    if (!isValid) {
      throw new Error("Verification code did not match. Please verify your system clock and authenticator app.");
    }

    await adminRepository.enableTotp(req.admin!.id, encryptSecret(secret), recoveryCodes);
    await auditService.log(req, "admin.totp.enabled", "admin", req.admin!.id, {
      recoveryCodesCount: recoveryCodes.length
    });

    return { message: "Two-factor authentication successfully enabled." };
  }

  async disableTotp(req: Request, currentPassword: string) {
    const admin = await adminRepository.findById(req.admin!.id);
    if (!admin || !(await bcrypt.compare(currentPassword, admin.password_hash))) {
      throw new Error("Current administrator password is incorrect.");
    }

    await adminRepository.disableTotp(req.admin!.id);
    await auditService.log(req, "admin.totp.disabled", "admin", req.admin!.id);

    return { message: "Two-factor authentication has been disabled." };
  }

  async regenerateRecoveryCodes(req: Request, currentPassword: string) {
    const admin = await adminRepository.findById(req.admin!.id);
    if (!admin || !(await bcrypt.compare(currentPassword, admin.password_hash))) {
      throw new Error("Current administrator password is incorrect.");
    }
    if (!admin.totp_enabled) {
      throw new Error("Two-factor authentication must be enabled before generating recovery codes.");
    }

    const newCodes = totpService.generateRecoveryCodes(8);
    await adminRepository.regenerateRecoveryCodes(req.admin!.id, newCodes);
    await auditService.log(req, "admin.totp.regenerate_recovery", "admin", req.admin!.id);

    return { recoveryCodes: newCodes };
  }

  async getSecurityStatus(req: Request) {
    const admin = await adminRepository.findById(req.admin!.id);
    if (!admin) throw new Error("Admin not found");

    return {
      totpEnabled: Boolean(admin.totp_enabled),
      recoveryCodesCount: admin.recovery_codes?.length || 0,
      passkeys: (admin.passkeys || []).map((p: PasskeyCredential) => ({
        id: p.id,
        name: p.name || "Passkey Device",
        createdAt: p.createdAt
      }))
    };
  }

  // Passkey WebAuthn Flows
  async getPasskeyRegisterOptions(req: Request) {
    throw new Error("Passkeys are temporarily unavailable until full WebAuthn signature verification is configured");
  }

  async verifyPasskeyRegister(req: Request, challengeId: string, credential: any, name?: string) {
    throw new Error("Passkeys are temporarily unavailable until full WebAuthn signature verification is configured");
  }

  async getPasskeyLoginOptions(req: Request) {
    throw new Error("Passkeys are temporarily unavailable until full WebAuthn signature verification is configured");
  }

  async verifyPasskeyLogin(req: Request, challengeId: string, credentialId: string) {
    throw new Error("Passkeys are temporarily unavailable until full WebAuthn signature verification is configured");
  }

  async removePasskey(req: Request, passkeyId: string) {
    await adminRepository.removePasskey(req.admin!.id, passkeyId);
    await auditService.log(req, "admin.passkey.deleted", "admin", req.admin!.id, { passkeyId });
    return { message: "Passkey removed successfully." };
  }

  async changePassword(req: Request, currentPassword: string, newPassword: string) {
    const admin = await adminRepository.findById(req.admin!.id);
    if (!admin || !(await bcrypt.compare(currentPassword, admin.password_hash))) {
      throw new Error("Current password is incorrect");
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    const token = (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
    await adminRepository.updatePassword(req.admin!.id, hashed, token ? tokenHash(token) : undefined);
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
