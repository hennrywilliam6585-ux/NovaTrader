import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  CreateCampaignBody,
  CreateCampaignResponse,
  GetAdminAnalyticsQueryParams,
  GetAdminAnalyticsResponse,
  ListAdminCampaignsResponse,
} from "@workspace/api-zod";
import { prisma } from "@workspace/db";
import { recordAdminAudit } from "../../lib/audit";
import { requireAdmin, type AdminRequest } from "../../lib/admin-auth";

const router: IRouter = Router();
router.use(requireAdmin);

function actor(req: AdminRequest) {
  if (!req.adminActor) throw new Error("Admin actor missing after authorization.");
  return req.adminActor;
}

function startOfUtcDay(value: Date): Date {
  const start = new Date(value);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

function shiftDays(value: Date, days: number): Date {
  const shifted = new Date(value);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function dayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function classifyChannel(sourceValue: string | null, mediumValue: string | null) {
  const source = sourceValue?.trim().toLowerCase() ?? "";
  const medium = mediumValue?.trim().toLowerCase() ?? "";
  const combined = `${source} ${medium}`;
  if (medium === "pdf" || source === "pdf") return "pdf" as const;
  if (medium === "docx" || source === "docx") return "docx" as const;
  if (/email|newsletter|mailing/.test(combined)) return "email" as const;
  if (/social|instagram|facebook|linkedin|tiktok|twitter|x\.com/.test(combined)) {
    return "social" as const;
  }
  if (!source && !medium) return "direct" as const;
  return "other" as const;
}

function normalizeUtm(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 60);
}

function campaignSlug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return normalized || "campaign";
}

function publicSiteOrigin(): string {
  const configured = process.env.PUBLIC_SITE_URL?.trim() || "https://blacktrading.com";
  const parsed = new URL(configured);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("PUBLIC_SITE_URL must use HTTP or HTTPS.");
  }
  return parsed.origin;
}

function campaignUrl(campaign: { source: string; medium: string; slug: string }): string {
  const url = new URL("/", publicSiteOrigin());
  url.searchParams.set("utm_source", campaign.source);
  url.searchParams.set("utm_medium", campaign.medium);
  url.searchParams.set("utm_campaign", campaign.slug);
  return url.toString();
}

router.get("/admin/analytics", async (req, res): Promise<void> => {
  const params = GetAdminAnalyticsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: "Invalid analytics range.", details: params.error.flatten() });
    return;
  }

  const range = params.data.range ?? "30d";
  const rangeDays = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const now = new Date();
  const todayStart = startOfUtcDay(now);
  const rangeStart = shiftDays(todayStart, -(rangeDays - 1));
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    countRows,
    returningRows,
    funnelRows,
    dailySessions,
    dailyPageViews,
    dailyPurchases,
    channelRows,
    campaignRows,
    registeredUsers,
  ] = await Promise.all([
    prisma.$queryRaw<Array<{
      totalVisits: number;
      uniqueVisitors: number;
      visitorsToday: number;
      visitorsThisWeek: number;
      visitorsThisMonth: number;
      totalPageViews: number;
      checkouts: number;
      paymentPages: number;
      purchases: number;
    }>>`
      SELECT
        (SELECT COUNT(*)::int FROM analytics_sessions WHERE started_at >= ${rangeStart}) AS "totalVisits",
        (SELECT COUNT(DISTINCT visitor_hash)::int FROM analytics_sessions WHERE started_at >= ${rangeStart}) AS "uniqueVisitors",
        (SELECT COUNT(DISTINCT visitor_hash)::int FROM analytics_sessions WHERE started_at >= ${todayStart}) AS "visitorsToday",
        (SELECT COUNT(DISTINCT visitor_hash)::int FROM analytics_sessions WHERE started_at >= ${weekStart}) AS "visitorsThisWeek",
        (SELECT COUNT(DISTINCT visitor_hash)::int FROM analytics_sessions WHERE started_at >= ${monthStart}) AS "visitorsThisMonth",
        (SELECT COUNT(*)::int FROM analytics_events WHERE event_type = 'page_view' AND created_at >= ${rangeStart}) AS "totalPageViews",
        (SELECT COUNT(DISTINCT session_id)::int FROM analytics_events WHERE event_type = 'checkout_visit' AND created_at >= ${rangeStart}) AS "checkouts",
        (SELECT COUNT(DISTINCT session_id)::int FROM analytics_events WHERE event_type = 'payment_page' AND created_at >= ${rangeStart}) AS "paymentPages",
        (SELECT COUNT(*)::int FROM orders WHERE payment_status = 'PAID' AND updated_at >= ${rangeStart}) AS "purchases"
    `,
    prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT visitor_hash
        FROM analytics_sessions
        GROUP BY visitor_hash
        HAVING COUNT(*) > 1 AND BOOL_OR(started_at >= ${rangeStart})
      ) AS returning_visitors
    `,
    prisma.$queryRaw<Array<{ paymentSubmissions: number; verifiedPurchases: number }>>`
      SELECT
        COUNT(DISTINCT o.id) FILTER (WHERE o.transaction_hash IS NOT NULL)::int AS "paymentSubmissions",
        COUNT(DISTINCT o.id) FILTER (
          WHERE o.payment_status = 'PAID' AND o.updated_at >= ${rangeStart}
        )::int AS "verifiedPurchases"
      FROM analytics_sessions s
      LEFT JOIN orders o ON o.analytics_session_id = s.id
      WHERE s.started_at >= ${rangeStart}
    `,
    prisma.$queryRaw<Array<{ date: string; visits: number; uniqueVisitors: number }>>`
      SELECT
        TO_CHAR(started_at::date, 'YYYY-MM-DD') AS date,
        COUNT(*)::int AS visits,
        COUNT(DISTINCT visitor_hash)::int AS "uniqueVisitors"
      FROM analytics_sessions
      WHERE started_at >= ${rangeStart}
      GROUP BY started_at::date
      ORDER BY started_at::date
    `,
    prisma.$queryRaw<Array<{ date: string; pageViews: number }>>`
      SELECT
        TO_CHAR(created_at::date, 'YYYY-MM-DD') AS date,
        COUNT(*)::int AS "pageViews"
      FROM analytics_events
      WHERE event_type = 'page_view' AND created_at >= ${rangeStart}
      GROUP BY created_at::date
      ORDER BY created_at::date
    `,
    prisma.$queryRaw<Array<{ date: string; purchases: number }>>`
      SELECT
        TO_CHAR(updated_at::date, 'YYYY-MM-DD') AS date,
        COUNT(*)::int AS purchases
      FROM orders
      WHERE payment_status = 'PAID' AND updated_at >= ${rangeStart}
      GROUP BY updated_at::date
      ORDER BY updated_at::date
    `,
    prisma.$queryRaw<Array<{ source: string | null; medium: string | null; visits: number }>>`
      SELECT source, medium, COUNT(*)::int AS visits
      FROM analytics_sessions
      WHERE started_at >= ${rangeStart}
      GROUP BY source, medium
    `,
    prisma.$queryRaw<Array<{
      campaignName: string;
      source: string;
      medium: string;
      visits: number;
      uniqueVisitors: number;
      purchases: number;
    }>>`
      SELECT
        COALESCE(c.name, s.campaign_name, 'Campaign') AS "campaignName",
        COALESCE(c.source, s.source, 'unknown') AS source,
        COALESCE(c.medium, s.medium, 'unknown') AS medium,
        COUNT(DISTINCT s.id)::int AS visits,
        COUNT(DISTINCT s.visitor_hash)::int AS "uniqueVisitors",
        COUNT(DISTINCT o.id)::int AS purchases
      FROM analytics_sessions s
      LEFT JOIN analytics_campaigns c ON c.id = s.campaign_id
      LEFT JOIN orders o
        ON o.analytics_session_id = s.id
        AND o.payment_status = 'PAID'
        AND o.updated_at >= ${rangeStart}
      WHERE s.started_at >= ${rangeStart}
        AND (s.campaign_id IS NOT NULL OR s.campaign_name IS NOT NULL)
      GROUP BY 1, 2, 3
      ORDER BY visits DESC, "campaignName" ASC
    `,
    prisma.user.count(),
  ]);

  const counts = countRows[0] ?? {
    totalVisits: 0,
    uniqueVisitors: 0,
    visitorsToday: 0,
    visitorsThisWeek: 0,
    visitorsThisMonth: 0,
    totalPageViews: 0,
    checkouts: 0,
    paymentPages: 0,
    purchases: 0,
  };
  const funnel = funnelRows[0] ?? { paymentSubmissions: 0, verifiedPurchases: 0 };
  const daily = new Map<string, {
    visits: number;
    uniqueVisitors: number;
    pageViews: number;
    purchases: number;
  }>();
  for (let day = new Date(rangeStart); day <= todayStart; day = shiftDays(day, 1)) {
    daily.set(dayKey(day), { visits: 0, uniqueVisitors: 0, pageViews: 0, purchases: 0 });
  }
  for (const row of dailySessions) {
    const point = daily.get(row.date);
    if (point) {
      point.visits = Number(row.visits);
      point.uniqueVisitors = Number(row.uniqueVisitors);
    }
  }
  for (const row of dailyPageViews) {
    const point = daily.get(row.date);
    if (point) point.pageViews = Number(row.pageViews);
  }
  for (const row of dailyPurchases) {
    const point = daily.get(row.date);
    if (point) point.purchases = Number(row.purchases);
  }

  const channels = new Map<"email" | "pdf" | "docx" | "social" | "direct" | "other", number>();
  for (const row of channelRows) {
    const category = classifyChannel(row.source, row.medium);
    channels.set(category, (channels.get(category) ?? 0) + Number(row.visits));
  }
  const uniqueVisitors = Number(counts.uniqueVisitors);
  const purchases = Number(counts.purchases);
  const campaigns = campaignRows.map((campaign) => ({
    ...campaign,
    visits: Number(campaign.visits),
    uniqueVisitors: Number(campaign.uniqueVisitors),
    purchases: Number(campaign.purchases),
    conversionRate: campaign.uniqueVisitors
      ? Number(campaign.purchases) / Number(campaign.uniqueVisitors) * 100
      : 0,
  }));

  res.json(
    GetAdminAnalyticsResponse.parse({
      range,
      visitorsToday: Number(counts.visitorsToday),
      visitorsThisWeek: Number(counts.visitorsThisWeek),
      visitorsThisMonth: Number(counts.visitorsThisMonth),
      totalVisits: Number(counts.totalVisits),
      uniqueVisitors,
      returningVisitors: Number(returningRows[0]?.count ?? 0),
      registeredUsers,
      totalPageViews: Number(counts.totalPageViews),
      checkouts: Number(counts.checkouts),
      purchases,
      conversionRate: uniqueVisitors ? purchases / uniqueVisitors * 100 : 0,
      timeSeries: Array.from(daily.entries()).map(([date, point]) => ({ date, ...point })),
      channels: Array.from(channels.entries())
        .map(([category, visits]) => ({ category, visits }))
        .sort((a, b) => b.visits - a.visits),
      campaigns,
      funnel: {
        visitors: uniqueVisitors,
        checkoutVisits: Number(counts.checkouts),
        paymentPages: Number(counts.paymentPages),
        paymentSubmissions: Number(funnel.paymentSubmissions),
        verifiedPurchases: Number(funnel.verifiedPurchases),
      },
    }),
  );
});

router.get("/admin/campaigns", async (_req, res): Promise<void> => {
  const [campaigns, stats] = await Promise.all([
    prisma.analyticsCampaign.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.$queryRaw<Array<{
      campaignId: string;
      visits: number;
      uniqueVisitors: number;
      purchases: number;
    }>>`
      SELECT
        c.id AS "campaignId",
        COUNT(DISTINCT s.id)::int AS visits,
        COUNT(DISTINCT s.visitor_hash)::int AS "uniqueVisitors",
        COUNT(DISTINCT o.id)::int AS purchases
      FROM analytics_campaigns c
      LEFT JOIN analytics_sessions s ON s.campaign_id = c.id
      LEFT JOIN orders o
        ON o.analytics_session_id = s.id
        AND o.payment_status = 'PAID'
      GROUP BY c.id
    `,
  ]);
  const byCampaign = new Map(stats.map((row) => [row.campaignId, row]));
  res.json(
    ListAdminCampaignsResponse.parse(
      campaigns.map((campaign) => {
        const stat = byCampaign.get(campaign.id);
        const visits = Number(stat?.visits ?? 0);
        const uniqueVisitors = Number(stat?.uniqueVisitors ?? 0);
        const purchases = Number(stat?.purchases ?? 0);
        return {
          id: campaign.id,
          name: campaign.name,
          slug: campaign.slug,
          source: campaign.source,
          medium: campaign.medium,
          generatedUrl: campaignUrl(campaign),
          visits,
          uniqueVisitors,
          purchases,
          conversionRate: uniqueVisitors ? purchases / uniqueVisitors * 100 : 0,
          createdAt: campaign.createdAt,
        };
      }),
    ),
  );
});

router.post("/admin/campaigns", async (req, res): Promise<void> => {
  const parsed = CreateCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid campaign.", details: parsed.error.flatten() });
    return;
  }

  const name = parsed.data.name.trim();
  const source = normalizeUtm(parsed.data.source);
  const medium = normalizeUtm(parsed.data.medium);
  if (!source || !medium) {
    res.status(400).json({ error: "Source and medium must contain letters or numbers." });
    return;
  }

  const baseSlug = campaignSlug(name);
  const existing = await prisma.analyticsCampaign.findUnique({ where: { slug: baseSlug } });
  const slug = existing ? `${baseSlug}-${randomUUID().slice(0, 8)}` : baseSlug;
  const campaign = await prisma.analyticsCampaign.create({
    data: { name, slug, source, medium },
  });
  await recordAdminAudit(actor(req as AdminRequest), "create", "analytics_campaign", campaign.id, {
    source,
    medium,
  });

  res.status(201).json(
    CreateCampaignResponse.parse({
      id: campaign.id,
      name: campaign.name,
      slug: campaign.slug,
      source: campaign.source,
      medium: campaign.medium,
      generatedUrl: campaignUrl(campaign),
      visits: 0,
      uniqueVisitors: 0,
      purchases: 0,
      conversionRate: 0,
      createdAt: campaign.createdAt,
    }),
  );
});

export default router;
