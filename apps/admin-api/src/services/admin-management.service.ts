import bcrypt from "bcryptjs";
import { Request } from "express";
import { adminRepository } from "../repositories/admin.repository";
import { auditService } from "./audit";
import { validateAdministratorPassword } from "../utils/password-policy";

export class AdminManagementService {
  async list() {
    return { administrators: await adminRepository.listAdministrators() };
  }

  async create(req: Request, username: string, password: string, role: "owner" | "admin" | "viewer") {
    validateAdministratorPassword(password, username);
    const passwordHash = await bcrypt.hash(password, 12);
    const admin = await adminRepository.createAdministrator(username.trim(), passwordHash, role);
    await auditService.log(req, "admin.account.created", "admin", admin.id, { username: admin.username, role: admin.role });
    return { administrator: admin, message: "Administrator created. They must change the initial password at first sign-in." };
  }

  async update(req: Request, id: number, updates: { role?: "owner" | "admin" | "viewer"; active?: boolean }) {
    const updated = await adminRepository.updateAdministratorAccess(id, req.admin!.id, updates);
    if (!updated) throw new Error("Administrator account was not found.");
    await auditService.log(req, "admin.account.updated", "admin", id, updates);
    return { message: "Administrator account updated. Any affected sessions were revoked when access changed." };
  }
}

export const adminManagementService = new AdminManagementService();
