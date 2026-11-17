export type AdminRole = "owner" | "admin" | "viewer";

/** Owners are the organization-wide authority. Other roles must be explicitly
 * listed by a route; this keeps viewer access read-only by default. */
export function roleHasAccess(role: AdminRole, allowedRoles: readonly AdminRole[]): boolean {
  return role === "owner" || allowedRoles.includes(role);
}
