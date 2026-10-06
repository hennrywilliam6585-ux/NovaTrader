import { createHmac } from "node:crypto";
import { prisma } from "@workspace/db";

type SessionInput = {
  visitorToken: string;
  sessionToken: string;
  source?: string;
  medium?: string;
  campaign?: string;
  referrer?: string;
};

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is required for analytics token hashing.");
  return value;
}

export function isValidAnalyticsToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,128}$/.test(value);
}

function digestToken(namespace: "visitor" | "session", value: string): string {
  return createHmac("sha256", secret()).update(`${namespace}:${value}`).digest("hex");
}

function cleanLabel(value: string | undefined, maxLength: number): string | null {
  const cleaned = value?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength);
  return cleaned || null;
}

export function sanitizeAnalyticsPath(value: string): string {
  try {
    const parsed = new URL(value, "https://analytics.invalid");
    return (parsed.pathname || "/").slice(0, 512);
  } catch {
    return "/";
  }
}

function sanitizeReferrerOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin.slice(0, 512);
  } catch {
    return null;
  }
}

export async function getOrCreateAnalyticsSession(input: SessionInput): Promise<{ id: string } | null> {
  if (!isValidAnalyticsToken(input.visitorToken) || !isValidAnalyticsToken(input.sessionToken)) {
    return null;
  }

  const visitorHash = digestToken("visitor", input.visitorToken);
  const sessionHash = digestToken("session", input.sessionToken);
  const existing = await prisma.analyticsSession.findUnique({ where: { sessionHash } });
  if (existing && existing.visitorHash !== visitorHash) return null;

  const campaignValue = cleanLabel(input.campaign, 160);
  const campaign = campaignValue
    ? await prisma.analyticsCampaign.findUnique({ where: { slug: campaignValue } })
    : null;
  const source = campaign?.source ?? cleanLabel(input.source, 120);
  const medium = campaign?.medium ?? cleanLabel(input.medium, 120);
  const campaignName = campaign?.name ?? campaignValue;
  const now = new Date();

  const session = await prisma.analyticsSession.upsert({
    where: { sessionHash },
    create: {
      visitorHash,
      sessionHash,
      campaignId: campaign?.id ?? null,
      source,
      medium,
      campaignName,
      referrerOrigin: sanitizeReferrerOrigin(input.referrer),
      startedAt: now,
      lastSeenAt: now,
    },
    update: { lastSeenAt: now },
  });
  if (session.visitorHash !== visitorHash) return null;

  const attributionUpdate: {
    campaignId?: string;
    source?: string;
    medium?: string;
    campaignName?: string;
    referrerOrigin?: string;
  } = {};
  if (!session.campaignId && campaign?.id) attributionUpdate.campaignId = campaign.id;
  if (!session.source && source) attributionUpdate.source = source;
  if (!session.medium && medium) attributionUpdate.medium = medium;
  if (!session.campaignName && campaignName) attributionUpdate.campaignName = campaignName;
  if (!session.referrerOrigin) {
    const referrerOrigin = sanitizeReferrerOrigin(input.referrer);
    if (referrerOrigin) attributionUpdate.referrerOrigin = referrerOrigin;
  }

  const updated = Object.keys(attributionUpdate).length
    ? await prisma.analyticsSession.update({
        where: { id: session.id },
        data: attributionUpdate,
      })
    : session;
  return { id: updated.id };
}

export function isObviousAnalyticsBot(userAgent: string | undefined): boolean {
  return /bot|crawler|spider|headless|lighthouse|pagespeed|prerender|curl\/|wget\/|python-requests|facebookexternalhit|slackbot|discordbot|twitterbot/i.test(
    userAgent ?? "",
  );
}
