declare global {
  namespace Express {
    interface Request {
      admin?: {
        id: number;
        username: string;
        role: "owner" | "admin" | "viewer";
        mustChangePassword: boolean;
      };
      adminSessionToken?: string;
      adminSessionAuthSource?: "cookie" | "bearer";
      adminSessionCsrfHash?: string;
    }
  }
}

export {};
