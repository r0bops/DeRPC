import type { DelegationState } from "./delegation.ts";

export const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_UINT = (1n << 256n) - 1n;
const uint = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v <= MAX_UINT;
const address = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && BigInt(v) !== 0n;
const time = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function encodeStoreValue(value: unknown): string {
  return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? { $bigint: v.toString() } : v);
}

export function decodeStoreValue(value: string): unknown {
  return JSON.parse(value, (_key, v) => {
    if (record(v) && "$bigint" in v) {
      if (Object.keys(v).length !== 1 || typeof v.$bigint !== "string" || !/^(0|[1-9]\d{0,77})$/.test(v.$bigint)) throw new Error("invalid persisted integer");
      return BigInt(v.$bigint);
    }
    return v;
  });
}

/** Disk corruption must never silently reset a consumed cap or replay ledger. */
export function validateState(value: unknown, session: string): asserts value is DelegationState {
  if (!record(value) || value.session !== session || !uint(value.budget) || value.budget === 0n || !uint(value.total) || value.total > value.budget || !time(value.refundAfter) || !record(value.grants) || !record(value.reservations)) throw new Error("invalid persisted delegation state");
  const sponsored = value.mode === "sponsored-v1";
  if (value.mode !== undefined && value.mode !== "post-proof-v1" && !sponsored) throw new Error("invalid persisted delegation mode");
  if (sponsored) {
    if (!record(value.readAuthorizations) || !uint(value.price) || value.price === 0n || value.price > value.budget || !address(value.sessionKey) || !time(value.safetyMarginSeconds) || value.safetyMarginSeconds < 60 || (value.closing !== undefined && typeof value.closing !== "boolean")) throw new Error("invalid persisted sponsored configuration");
  } else if (value.readAuthorizations !== undefined || value.price !== undefined || value.sessionKey !== undefined || value.safetyMarginSeconds !== undefined || value.closing !== undefined) throw new Error("sponsored state cannot use the post-proof protocol");
  const grants = Object.entries(value.grants);
  const reservations = Object.entries(value.reservations);
  if (grants.length > 10000 || reservations.length > 10000) throw new Error("persisted delegation ledger exceeds limits");
  const spent = new Map<string, bigint>();
  const count = new Map<string, bigint>();
  let total = 0n;
  for (const [key, reservation] of reservations) {
    if (!record(reservation) || !address(reservation.userKey) || !uint(reservation.nonce) || key !== `${reservation.userKey.toLowerCase()}:${reservation.nonce}` || typeof reservation.digest !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(reservation.digest) || !uint(reservation.charge) || reservation.charge === 0n || !uint(reservation.cumulative) || reservation.cumulative < reservation.charge || reservation.cumulative > value.total) throw new Error("invalid persisted delegation reservation");
    const user = reservation.userKey.toLowerCase();
    spent.set(user, (spent.get(user) ?? 0n) + reservation.charge);
    count.set(user, (count.get(user) ?? 0n) + 1n);
    total += reservation.charge;
  }
  if (total !== value.total) throw new Error("persisted delegation total does not match reservations");
  let cumulative = 0n;
  const ordered = reservations.map(([, item]) => item as unknown as DelegationState["reservations"][string]).sort((a, b) => a.cumulative < b.cumulative ? -1 : a.cumulative > b.cumulative ? 1 : 0);
  for (const item of ordered) {
    cumulative += item.charge;
    if (item.cumulative !== cumulative) throw new Error("persisted delegation cumulative sequence is invalid");
  }
  if (sponsored) {
    const authorizations = Object.entries(value.readAuthorizations as Record<string, unknown>);
    if (authorizations.length > 4096) throw new Error("persisted sponsored authorization limit exceeded");
    let exposure = total;
    for (const [key, auth] of authorizations) {
      if (!record(auth) || !address(auth.userKey) || !uint(auth.nonce) || key !== `${auth.userKey.toLowerCase()}:${auth.nonce}` || auth.charge !== value.price || typeof auth.digest !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(auth.digest) || auth.readId !== auth.digest || typeof auth.requestHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(auth.requestHash) || !["proof", "code", "call"].includes(String(auth.kind)) || !time(auth.deadline) || !time(auth.expiresAt) || auth.deadline > auth.expiresAt || auth.expiresAt > value.refundAfter - Number(value.safetyMarginSeconds)) throw new Error("invalid persisted sponsored authorization");
      const completed = value.reservations[key];
      if (completed) {
        if (!record(completed) || completed.digest !== auth.digest || completed.charge !== auth.charge || completed.userKey !== auth.userKey || completed.nonce !== auth.nonce || typeof completed.readHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(completed.readHash)) throw new Error("sponsored completion does not match its authorization");
      } else {
        const user = auth.userKey.toLowerCase();
        spent.set(user, (spent.get(user) ?? 0n) + (auth.charge as bigint));
        count.set(user, (count.get(user) ?? 0n) + 1n);
        exposure += auth.charge as bigint;
      }
    }
    if (exposure > value.budget || reservations.some(([key]) => !(key in (value.readAuthorizations as Record<string, unknown>)))) throw new Error("invalid persisted sponsored exposure");
  }
  for (const [user, grant] of grants) {
    if (!address(user) || user !== user.toLowerCase() || !record(grant) || !uint(grant.cap) || grant.cap > value.budget || !uint(grant.spent) || grant.spent > grant.cap || grant.spent !== (spent.get(user) ?? 0n) || !uint(grant.nextNonce) || grant.nextNonce !== (count.get(user) ?? 0n) || !time(grant.expiresAt) || grant.expiresAt > value.refundAfter || typeof grant.revoked !== "boolean") throw new Error("invalid persisted delegation grant");
    for (let nonce = 0n; nonce < grant.nextNonce; nonce++) if (!(`${user}:${nonce}` in value.reservations) && !(sponsored && `${user}:${nonce}` in (value.readAuthorizations as Record<string, unknown>))) throw new Error("persisted delegation nonce gap");
    spent.delete(user);
  }
  if (spent.size) throw new Error("persisted delegation reservation has no grant");
  if (value.latestVoucher !== undefined) {
    const voucher = value.latestVoucher;
    if (!record(voucher) || !uint(voucher.sessionId) || voucher.sessionId === 0n || voucher.sessionId.toString() !== session.split(":").at(-1) || !uint(voucher.amount) || !(sponsored && value.closing && voucher.amount === 0n && value.total === 0n) && !ordered.some(item => item.cumulative === voucher.amount) || typeof voucher.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(voucher.signature)) throw new Error("invalid persisted delegation voucher");
  }
}

/** Even a mistaken trusted caller cannot roll counters or replace consumed authorizations back. */
export function validateTransition(previous: DelegationState | undefined, next: DelegationState): void {
  if (!previous) return;
  if (next.session !== previous.session || next.budget !== previous.budget || next.refundAfter !== previous.refundAfter || next.total < previous.total) throw new Error("delegation state rollback or reconfiguration refused");
  if ((next.mode ?? "post-proof-v1") !== (previous.mode ?? "post-proof-v1") || next.price !== previous.price || next.sessionKey !== previous.sessionKey || next.safetyMarginSeconds !== previous.safetyMarginSeconds || (previous.closing && !next.closing)) throw new Error("delegation protocol or terminal state change refused");
  if (previous.closing && (next.total !== previous.total || Object.keys(next.readAuthorizations ?? {}).length !== Object.keys(previous.readAuthorizations ?? {}).length)) throw new Error("sponsored session is terminal");
  for (const [key, authorization] of Object.entries(previous.readAuthorizations ?? {})) {
    const updated = next.readAuthorizations?.[key];
    if (!updated || Object.entries(authorization).some(([field, value]) => updated[field as keyof typeof authorization] !== value)) throw new Error("sponsored authorization replacement refused");
  }
  for (const [user, grant] of Object.entries(previous.grants)) {
    const updated = next.grants[user];
    if (!updated || updated.spent < grant.spent || updated.nextNonce < grant.nextNonce) throw new Error("delegation grant rollback refused");
  }
  for (const [key, reservation] of Object.entries(previous.reservations)) {
    const updated = next.reservations[key];
    if (!updated || updated.digest !== reservation.digest || updated.userKey !== reservation.userKey || updated.nonce !== reservation.nonce || updated.charge !== reservation.charge || updated.cumulative !== reservation.cumulative || updated.readHash !== reservation.readHash) throw new Error("delegation reservation replacement refused");
  }
  if (previous.latestVoucher && (!next.latestVoucher || next.latestVoucher.amount < previous.latestVoucher.amount || (next.latestVoucher.amount === previous.latestVoucher.amount && next.latestVoucher.signature !== previous.latestVoucher.signature))) throw new Error("delegation voucher rollback refused");
}
