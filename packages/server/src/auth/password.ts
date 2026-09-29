import { hash, verify } from "@node-rs/argon2";

export async function hashPassword(secret: string): Promise<string> {
  return hash(secret);
}

export async function verifyPassword(hashed: string, secret: string): Promise<boolean> {
  try {
    return await verify(hashed, secret);
  } catch {
    return false;
  }
}
