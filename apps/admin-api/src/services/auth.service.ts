import bcrypt from "bcryptjs";
import { randomUUID, randomBytes } from "crypto";
import { Request } from "express";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { env } from "../config/env";
import { adminRepository } from "../repositories/admin.repository";
import { createToken, tokenHash } from "../middleware/auth";
import { auditService } from "./audit";
import { totpService } from "./totp.service";
import { PasskeyCredential } from "../models/entities";
import { decryptSecret, encryptSecret } from "../utils/secret-crypto";
import { validateAdministratorPassword } from "../utils/password-policy";

interface MfaPendingSession {
  adminId: number;
  username: string;
  expiresAt: number;
  attempts: number;
}

interface PasskeyPendingChallenge {
  challenge: string;
  adminId?: number;
  origin: string;
  rpId: string;
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

  private getWebAuthnOrigin(req: Request): string {
    const origin = req.header("origin");
    if (!origin) throw new Error("Passkey requests must include a browser Origin header.");
    const parsed = new URL(origin);
    const rpId = this.getWebAuthnRpId(req);
    if (parsed.hostname !== rpId && !parsed.hostname.endsWith("." + rpId)) {
      throw new Error("Passkey origin does not match the configured relying party.");
    }
    return parsed.origin;
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

    if (!admin) {
      await auditService.log(req, "admin.login.failed", "admin", undefined, {
        attemptedUsername: username,
        reason: "Invalid administrator credentials",
        error: "Authentication failed",
        clientIp: req.ip || null
      });
      throw new Error("Invalid credentials or account temporarily unavailable.");
    }

    const isLocked = Boolean(admin.locked_until && new Date(admin.locked_until) > new Date());
    if (isLocked) {
      await auditService.log(req, "admin.login.failed", "admin", admin.id, {
        attemptedUsername: username,
        reason: "Account temporarily locked due to failed login attempts",
        error: "Authentication failed",
        clientIp: req.ip || null
      });
      throw new Error("Invalid credentials or account temporarily unavailable.");
    }

    if (!admin.active) {
      await auditService.log(req, "admin.login.failed", "admin", admin.id, {
        attemptedUsername: username,
        reason: "Account is inactive",
        error: "Authentication failed",
        clientIp: req.ip || null
      });
      throw new Error("Invalid credentials or account temporarily unavailable.");
    }

    const passwordMatches = await bcrypt.compare(password, admin.password_hash);
    if (!passwordMatches) {
      await adminRepository.recordFailedLogin(admin.id);
      await auditService.log(req, "admin.login.failed", "admin", admin.id, {
        attemptedUsername: username,
        reason: "Invalid administrator credentials",
        error: "Authentication failed",
        clientIp: req.ip || null
      });
      throw new Error("Invalid credentials or account temporarily unavailable.");
    }

    // Check if Two-Factor Authentication (TOTP) is enabled for this admin
    if (admin.totp_enabled && admin.totp_secret) {
      const mfaToken = randomUUID();
      this.mfaPendingSessions.set(mfaToken, {
        adminId: admin.id,
        username: admin.username,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes validity
        attempts: 0
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
    if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
      this.mfaPendingSessions.delete(mfaToken);
      throw new Error("Invalid credentials or account temporarily unavailable.");
    }

    if (code) {
      const isValid = totpService.verifyTotp(code, decryptSecret(admin.totp_secret || ""));
      if (!isValid) {
        pending.attempts += 1;
        await adminRepository.recordFailedLogin(admin.id);
        if (pending.attempts >= 5) this.mfaPendingSessions.delete(mfaToken);
        await auditService.log(req, "admin.mfa.failed", "admin", admin.id, {
          username: admin.username,
          method: "totp",
          attempts: pending.attempts,
          reason: "Invalid 6-digit TOTP code"
        });
        throw new Error(pending.attempts >= 5
          ? "Too many verification attempts. Sign in again."
          : "Invalid 6-digit verification code. Please check your authenticator app.");
      }
    } else if (recoveryCode) {
      const consumed = await adminRepository.consumeRecoveryCode(admin.id, recoveryCode);
      if (!consumed) {
        pending.attempts += 1;
        await adminRepository.recordFailedLogin(admin.id);
        if (pending.attempts >= 5) this.mfaPendingSessions.delete(mfaToken);
        await auditService.log(req, "admin.mfa.failed", "admin", admin.id, {
          username: admin.username,
          method: "recovery_code",
          attempts: pending.attempts,
          reason: "Invalid or already consumed recovery code"
        });
        throw new Error(pending.attempts >= 5
          ? "Too many verification attempts. Sign in again."
          : "Invalid or previously used recovery code.");
      }
    } else {
      throw new Error("Either 6-digit code or emergency recovery code is required.");
    }

    this.mfaPendingSessions.delete(mfaToken);
    return this.finalizeSuccessfulLogin(req, admin, recoveryCode ? "recovery_code" : "totp");
  }

  private async finalizeSuccessfulLogin(req: Request, admin: any, authMethod: string) {
    const token = createToken();
    const csrfToken = randomBytes(32).toString("base64url");
    await adminRepository.recordSuccessfulLogin(admin.id);

    const sessionId = randomUUID();
    const userAgent = req.header("user-agent") || null;
    const ip = req.ip || null;

    await adminRepository.createSession(
      sessionId,
      admin.id,
      tokenHash(token),
      tokenHash(csrfToken),
      env.sessionHours,
      ip,
      userAgent,
      env.adminMaxSessions,
      env.sessionIdleMinutes
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
      csrfToken,
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
    validateAdministratorPassword(newPassword, username);

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

  async getPasskeyRegisterOptions(req: Request) {
    const admin = await adminRepository.findById(req.admin!.id);
    if (!admin) throw new Error("Admin not found");

    const challengeId = randomUUID();
    const challenge = Uint8Array.from(randomBytes(32));
    const rpId = this.getWebAuthnRpId(req);
    const origin = this.getWebAuthnOrigin(req);

    const options = await generateRegistrationOptions({
      rpID: rpId,
      rpName: env.webauthnRpName || "MailCore Admin Console",
      userID: new TextEncoder().encode(String(admin.id)),
      userName: admin.username,
      userDisplayName: admin.username,
      challenge,
      attestationType: "none",
      timeout: 60000,
      // Registration must create a credential capable of satisfying the verification
      // requirement enforced when this credential is later used to sign in.
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      excludeCredentials: (admin.passkeys || []).map((passkey: PasskeyCredential) => ({
        id: passkey.id,
        transports: passkey.transports
      }))
    });
    this.passkeyChallenges.set(challengeId, {
      challenge: options.challenge,
      adminId: admin.id,
      origin,
      rpId,
      expiresAt: Date.now() + 5 * 60 * 1000
    });
    return { challengeId, ...options };
  }

  async verifyPasskeyRegister(req: Request, challengeId: string, credential: any, name?: string) {
    this.cleanupExpiredSessions();
    const pending = this.passkeyChallenges.get(challengeId);
    if (!pending || pending.expiresAt < Date.now()) {
      this.passkeyChallenges.delete(challengeId);
      throw new Error("Passkey registration challenge expired. Please try again.");
    }

    const admin = await adminRepository.findById(pending.adminId!);
    if (!admin) {
      this.passkeyChallenges.delete(challengeId);
      throw new Error("Admin not found");
    }

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.origin,
      expectedRPID: pending.rpId,
      requireUserVerification: true
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new Error("Passkey registration could not be verified.");
    }

    const registeredCredential = verification.registrationInfo.credential;
    const newPasskey: PasskeyCredential = {
      id: credential.id,
      rawId: credential.rawId,
      name: name || "Security Key",
      publicKey: Buffer.from(registeredCredential.publicKey).toString("base64url"),
      counter: registeredCredential.counter,
      transports: credential.response?.transports,
      createdAt: new Date().toISOString()
    };

    await adminRepository.addPasskey(admin.id, newPasskey);
    this.passkeyChallenges.delete(challengeId);

    await auditService.log(req, "admin.passkey.registered", "admin", admin.id, {
      name: newPasskey.name,
      passkeyId: newPasskey.id
    });

    return { message: "Passkey registered successfully." };
  }

  async getPasskeyLoginOptions(req: Request) {
    this.cleanupExpiredSessions();
    const challengeId = randomUUID();
    const challenge = Uint8Array.from(randomBytes(32));
    const rpId = this.getWebAuthnRpId(req);
    const origin = this.getWebAuthnOrigin(req);

    const options = await generateAuthenticationOptions({
      rpID: rpId,
      challenge,
      timeout: 60000,
      userVerification: "required"
    });
    this.passkeyChallenges.set(challengeId, {
      challenge: options.challenge,
      origin,
      rpId,
      expiresAt: Date.now() + 5 * 60 * 1000
    });
    return { challengeId, ...options };
  }

  async verifyPasskeyLogin(req: Request, challengeId: string, credential: any) {
    this.cleanupExpiredSessions();
    const pending = this.passkeyChallenges.get(challengeId);
    if (!pending || pending.expiresAt < Date.now()) {
      this.passkeyChallenges.delete(challengeId);
      throw new Error("Passkey login session expired. Please try again.");
    }

    const admin = await adminRepository.findAdminByPasskeyId(credential.id);
    if (!admin || !admin.active) {
      this.passkeyChallenges.delete(challengeId);
      throw new Error("Passkey not recognized or account is inactive.");
    }
    if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
      this.passkeyChallenges.delete(challengeId);
      throw new Error("Account temporarily unavailable. Try again later.");
    }
    const storedPasskey = (admin.passkeys || []).find((passkey: PasskeyCredential) => passkey.id === credential.id);
    if (!storedPasskey?.publicKey || storedPasskey.counter === undefined) {
      this.passkeyChallenges.delete(challengeId);
      throw new Error("This passkey uses an obsolete registration. Register it again.");
    }

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpId,
        requireUserVerification: true,
        credential: {
          id: storedPasskey.id,
          publicKey: Buffer.from(storedPasskey.publicKey, "base64url"),
          counter: storedPasskey.counter,
          transports: storedPasskey.transports
        }
      });
      if (!verification.verified) throw new Error("Passkey signature verification failed.");
    } catch (error) {
      this.passkeyChallenges.delete(challengeId);
      await adminRepository.recordFailedLogin(admin.id);
      await auditService.log(req, "admin.passkey.login.failed", "admin", admin.id, {
        method: "passkey", reason: "Passkey assertion verification failed"
      });
      throw new Error("Passkey authentication failed.");
    }

    this.passkeyChallenges.delete(challengeId);
    await adminRepository.updatePasskeyCounter(admin.id, storedPasskey.id, verification.authenticationInfo.newCounter);
    return this.finalizeSuccessfulLogin(req, admin, "passkey");
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

    validateAdministratorPassword(newPassword, admin.username);
    if (await bcrypt.compare(newPassword, admin.password_hash)) {
      throw new Error("Choose a password you have not used for this account.");
    }
    const hashed = await bcrypt.hash(newPassword, 12);
    const token = req.adminSessionToken;
    await adminRepository.updatePassword(req.admin!.id, hashed, token ? tokenHash(token) : undefined);
    await auditService.log(req, "admin.password.change", "admin", req.admin!.id);
  }

  async logout(req: Request) {
    const token = req.adminSessionToken;
    if (token) {
      await adminRepository.revokeSession(tokenHash(token));
      await auditService.log(req, "admin.logout", "admin", req.admin!.id);
    }
  }

  async listSessions(req: Request) {
    const token = req.adminSessionToken;
    const currentHash = token ? tokenHash(token) : "";
    const sessions = await adminRepository.listActiveSessions(req.admin!.id, env.sessionIdleMinutes);
    const currentSessionId = currentHash ? await adminRepository.getSessionIdByTokenHash(currentHash) : null;
    return {
      sessions: sessions.map((session) => ({ ...session, current: session.id === currentSessionId }))
    };
  }

  async revokeSession(req: Request, sessionId: string) {
    const revoked = await adminRepository.revokeSessionById(req.admin!.id, sessionId);
    if (!revoked) throw new Error("Active session was not found.");
    await auditService.log(req, "admin.session.revoked", "admin_session", sessionId);
    return { message: "Session revoked." };
  }

  async revokeOtherSessions(req: Request) {
    const token = req.adminSessionToken;
    if (!token) throw new Error("Current session is missing.");
    const count = await adminRepository.revokeOtherSessions(req.admin!.id, tokenHash(token));
    await auditService.log(req, "admin.sessions.revoked_others", "admin", req.admin!.id, { revokedCount: count });
    return { revokedCount: count };
  }

  async getCurrentProfile(req: Request) {
    return { admin: req.admin };
  }
}

export const authService = new AuthService();
