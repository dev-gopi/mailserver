declare namespace Express {
  export interface Request { admin?: { id: number; username: string; role: "owner" | "admin" | "viewer"; mustChangePassword: boolean }; }
}
