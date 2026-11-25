export function sameConnectionUser(
  stored: { asanaUserGid: string | null; asanaUserId: string; plakyUserId: number },
  current: { asanaUserGid?: string | null; asanaUserId: string; plakyUserId: number },
): boolean {
  if (stored.plakyUserId !== current.plakyUserId || !current.asanaUserGid) return false;
  if (stored.asanaUserGid !== null) return stored.asanaUserGid === current.asanaUserGid;
  const email = stored.asanaUserId.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email === current.asanaUserId.trim().toLowerCase();
}
