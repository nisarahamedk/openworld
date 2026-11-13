// Clerk stand-in: the Backend API calls an app makes (JWKS, users) and session tokens for the world's people.
// The world holds its own signing key, so the app verifies tokens exactly as it does in production, against
// GET /v1/jwks. Publishable key for world vars: pk_test_ + base64("world.clerk.accounts.dev$").
import type { Twin, World } from "../host/world.ts";

export const WORLD_CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from("world.clerk.accounts.dev$").toString("base64")}`;

type User = { id: string; email: string; phone: string | null; createdAt: number; metadata: { public: object; private: object; unsafe: object } };

const b64url = (b: ArrayBuffer | Uint8Array | string) => Buffer.from(typeof b === "string" ? b : new Uint8Array(b)).toString("base64url");

export class ClerkTwin implements Twin {
  readonly name = "clerk";
  private readonly users = new Map<string, User>();
  private keys: Promise<CryptoKeyPair> | null = null;
  private jwk: JsonWebKey | null = null;
  private n = 0;

  private readonly world: World;
  constructor(world: World) {
    this.world = world;
  }

  // One key for the whole world (a promise, so concurrent first callers share it).
  private keyPair(): Promise<CryptoKeyPair> {
    this.keys ??= (async () => {
      const keys = (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      this.jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
      return keys;
    })();
    return this.keys;
  }

  createUser(email: string, phone: string | null = null): User {
    const id = `user_world${String(++this.n).padStart(6, "0")}${this.world.rng.int(1000, 9999)}`;
    const u: User = { id, email, phone, createdAt: Date.now(), metadata: { public: {}, private: {}, unsafe: {} } };
    this.users.set(id, u);
    return u;
  }

  /** A fresh session token for the user, as Clerk's frontend would mint it (60 s life). */
  async token(userId: string): Promise<string> {
    const { privateKey } = await this.keyPair();
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "world-key" }));
    const payload = b64url(
      JSON.stringify({ sub: userId, sid: `sess_${userId.slice(5)}`, iat: now, nbf: now - 5, exp: now + 60, iss: "https://world.clerk.accounts.dev", azp: this.world.origin, v: 2 }),
    );
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${header}.${payload}`));
    return `${header}.${payload}.${b64url(sig)}`;
  }

  /** Authorization header for a request as this user. */
  async auth(userId: string): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.token(userId)}` };
  }

  private json(u: User) {
    const ts = u.createdAt;
    return {
      object: "user",
      id: u.id,
      username: null,
      first_name: null,
      last_name: null,
      image_url: "",
      has_image: false,
      primary_email_address_id: `idn_e_${u.id}`,
      primary_phone_number_id: u.phone ? `idn_p_${u.id}` : null,
      primary_web3_wallet_id: null,
      password_enabled: false,
      two_factor_enabled: false,
      totp_enabled: false,
      backup_code_enabled: false,
      email_addresses: [{ object: "email_address", id: `idn_e_${u.id}`, email_address: u.email, verification: { status: "verified", strategy: "email_code", attempts: null, expire_at: null }, linked_to: [], reserved: false }],
      phone_numbers: u.phone
        ? [{ object: "phone_number", id: `idn_p_${u.id}`, phone_number: u.phone, verification: { status: "verified", strategy: "phone_code", attempts: null, expire_at: null }, linked_to: [], reserved_for_second_factor: false, default_second_factor: false, backup_codes: null }]
        : [],
      web3_wallets: [],
      passkeys: [],
      external_accounts: [],
      saml_accounts: [],
      enterprise_accounts: [],
      public_metadata: u.metadata.public,
      private_metadata: u.metadata.private,
      unsafe_metadata: u.metadata.unsafe,
      external_id: null,
      last_sign_in_at: ts,
      banned: false,
      locked: false,
      lockout_expires_in_seconds: null,
      verification_attempts_remaining: 100,
      created_at: ts,
      updated_at: ts,
      delete_self_enabled: true,
      create_organization_enabled: false,
      last_active_at: ts,
      legal_accepted_at: null,
    };
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/v1/, "");
    if (path === "/jwks") {
      await this.keyPair();
      return Response.json({ keys: [{ ...this.jwk, kid: "world-key", alg: "RS256", use: "sig" }] });
    }
    const m = /^\/users\/([^/]+)(\/metadata)?$/.exec(path);
    if (m) {
      const u = this.users.get(decodeURIComponent(m[1] as string));
      if (!u) return Response.json({ errors: [{ code: "resource_not_found", message: "not found" }] }, { status: 404 });
      if (req.method === "DELETE") {
        this.users.delete(u.id);
        return Response.json({ object: "user", id: u.id, deleted: true });
      }
      if (req.method === "PATCH") {
        const body = (await req.json().catch(() => ({}))) as Record<string, object>;
        if (body.public_metadata) Object.assign(u.metadata.public, body.public_metadata);
        if (body.private_metadata) Object.assign(u.metadata.private, body.private_metadata);
        if (body.unsafe_metadata) Object.assign(u.metadata.unsafe, body.unsafe_metadata);
      }
      return Response.json(this.json(u));
    }
    if (path === "/sign_in_tokens" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { user_id?: string };
      return Response.json({ object: "sign_in_token", id: `sit_${Date.now()}`, user_id: body.user_id, token: `world_ticket_${Date.now()}`, status: "pending", url: "", created_at: Date.now(), updated_at: Date.now() });
    }
    return Response.json({ errors: [{ code: "world_not_modelled", message: `Clerk twin has no ${req.method} ${path}` }] }, { status: 501 });
  }
}

export const clerk = (world: World) => new ClerkTwin(world);
