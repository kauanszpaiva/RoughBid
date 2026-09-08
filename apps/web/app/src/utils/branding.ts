/** Display-only branding for the requested owner profile. Never changes saved
 * profile details or gives another account owner privileges. */
export function ownerProfileImage(email?: string | null): string | undefined {
  return email?.trim().toLowerCase() === "kauan@kspdominion.group"
    ? "/brand/roughbid-mark.png"
    : undefined;
}
