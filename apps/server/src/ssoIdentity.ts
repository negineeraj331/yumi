/**
 * The part of single sign-on that decides *which account* an assertion refers to.
 *
 * Shared by OIDC and SAML deliberately. Both protocols end in the same question
 * — "someone has proved an identity at an external provider; whose Yumi account
 * is that?" — and it is the question with the takeover risk in it, so there is
 * one implementation of the answer rather than one per protocol.
 */
import { User } from "./models.js";
import { audit } from "./auth.js";
import { config } from "./config.js";
import { pickCollaboratorColor } from "@yumi/shared";

/**
 * Only relative, single-slash paths are accepted as a return destination —
 * "//evil.com" and "https://evil.com" are both absolute and would be an open
 * redirect out of the app.
 */
export function safeReturnPath(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  return /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#[\]]*$/.test(s) ? s : "/";
}

/** Send a failed sign-in back to the login page with a readable reason. */
export const failToLogin = (res: any, reason: string) =>
  res.redirect(`${config.clientOrigin}/login?sso_error=${encodeURIComponent(reason)}`);

export interface SsoClaims {
  /** The provider's own stable identifier for this person. */
  sub: string;
  email?: string;
  /**
   * Whether this deployment trusts the provider's word on that address.
   *
   * OIDC gets it from the `email_verified` claim. SAML has no equivalent — the
   * protocol has no notion of a verified address — so it comes from an explicit
   * per-provider setting instead. Either way it means the same thing here, and
   * it is what gates the only genuinely dangerous case: attaching an external
   * identity to an account that already exists.
   */
  emailTrusted: boolean;
  name?: string;
}

export interface SsoPolicy {
  /**
   * Whether an account may be *created* for an address the provider's word is
   * not trusted on.
   *
   * Creating an account for an address nobody holds cannot take anything over,
   * so this is a weaker question than linking. SAML allows it, because
   * provisioning people on first sign-in is the entire point of an enterprise
   * IdP and refusing would leave the connection unable to onboard anyone. OIDC
   * does not, because a public consumer provider may be asserting an address
   * that belongs to somebody else, and creating the account would let it be
   * squatted before the real owner ever arrives.
   */
  createWithUntrustedEmail?: boolean;
}

/**
 * Find or create the account behind a verified assertion.
 *
 * Order matters: an existing *identity* wins, because the provider's subject is
 * the stable key and an email can change hands. Falling back to email is only
 * safe when the address is trusted — otherwise anyone able to assert an address
 * at a sloppy provider could inherit the matching Yumi account.
 */
export async function resolveSsoUser(
  providerId: string,
  claims: SsoClaims,
  ip?: string,
  policy: SsoPolicy = {},
) {
  const existing = await User.findOne({
    oauthProviders: { $elemMatch: { provider: providerId, providerUserId: claims.sub } },
  });
  if (existing) return existing;

  if (!claims.email) throw new Error("The provider did not supply an email address");

  const byEmail = await User.findOne({ email: claims.email });
  if (byEmail) {
    if (!claims.emailTrusted) {
      throw new Error("That email is already registered and the provider has not verified it");
    }
    byEmail.oauthProviders.push({ provider: providerId, providerUserId: claims.sub, linkedAt: new Date() } as any);
    await byEmail.save();
    await audit({ actorId: String(byEmail._id), action: "auth.sso.linked", meta: { provider: providerId }, ip });
    return byEmail;
  }

  if (!claims.emailTrusted && !policy.createWithUntrustedEmail) {
    throw new Error("The provider has not verified that email address");
  }

  const created = await User.create({
    email: claims.email,
    displayName: claims.name || claims.email.split("@")[0],
    avatarColor: pickCollaboratorColor(Date.now() + claims.sub.length),
    // No passwordHash: this account signs in through the provider only.
    passwordHash: null,
    oauthProviders: [{ provider: providerId, providerUserId: claims.sub, linkedAt: new Date() }],
  });
  await audit({ actorId: String(created._id), action: "auth.sso.registered", meta: { provider: providerId }, ip });
  return created;
}
