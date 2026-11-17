const commonPasswords = new Set([
  "passwordpassword", "password123456", "12345678901234", "qwertyuiopasdf",
  "adminadminadmin", "welcome1234567", "letmein1234567", "changeme123456"
]);

export function validateAdministratorPassword(password: string, username?: string): void {
  if (password.length < 14) throw new Error("Administrator passwords must contain at least 14 characters.");
  if (password.length > 128) throw new Error("Administrator passwords cannot exceed 128 characters.");
  if (/^(.)(\1){7,}$/.test(password)) throw new Error("Choose a less predictable password.");
  const normalized = password.toLowerCase().replace(/[\s._-]/g, "");
  if (commonPasswords.has(normalized)) throw new Error("This password is too common. Choose a unique passphrase.");
  if (username && normalized.includes(username.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
    throw new Error("Administrator passwords must not contain the username.");
  }
}
