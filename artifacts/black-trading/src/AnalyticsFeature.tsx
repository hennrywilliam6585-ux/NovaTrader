import { useEffect, useMemo, useRef, useState, createContext, useContext, type ReactNode, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  getGetAdminAnalyticsQueryKey, getListAdminCampaignsQueryKey,
  useCreateCampaign, useGetAdminAnalytics, useListAdminCampaigns, useTrackAnalyticsEvent,
  useSyncRegisteredUser,
} from "@workspace/api-client-react";
import type { AnalyticsSummary, Campaign } from "@workspace/api-client-react";
import { Activity, ArrowDownRight, ArrowUpRight, Check, Copy, ExternalLink, MousePointer2, Plus, RefreshCw, ShieldCheck, Users } from "lucide-react";

type ConsentStatus = "accepted" | "rejected" | "unset";
type Attribution = { source?: string; medium?: string; campaign?: string };
type ConsentValue = { accepted: boolean; visitorToken?: string; sessionToken?: string };
const ConsentContext = createContext<ConsentValue>({ accepted: false });
const CONSENT_KEY = "bt.analytics.consent";
const VISITOR_KEY = "bt.analytics.visitor";
const SESSION_KEY = "bt.analytics.session";
const ATTRIBUTION_KEY = "bt.analytics.first-touch";

function randomToken() {
  const secureCrypto = window.crypto;
  if (typeof secureCrypto.randomUUID === "function") return secureCrypto.randomUUID();
  const bytes = new Uint8Array(24);
  secureCrypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function getToken(storage: Storage, key: string) {
  let token = storage.getItem(key);
  if (!token) { token = randomToken(); storage.setItem(key, token); }
  return token;
}
function currentAttribution(): Attribution {
  try {
    const saved = sessionStorage.getItem(ATTRIBUTION_KEY);
    if (saved) return JSON.parse(saved) as Attribution;
    const params = new URLSearchParams(window.location.search);
    const clean = (value: string | null, max: number) => value?.trim().slice(0, max) || undefined;
    const first: Attribution = {
      source: clean(params.get("utm_source"), 120),
      medium: clean(params.get("utm_medium"), 120),
      campaign: clean(params.get("utm_campaign"), 160),
    };
    if (first.source || first.medium || first.campaign) sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(first));
    return first;
  } catch { return {}; }
}

export function useAnalyticsConsent() { return useContext(ConsentContext); }

export function ConsentProvider({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  const [status, setStatus] = useState<ConsentStatus>(() => {
    try { return (localStorage.getItem(CONSENT_KEY) as ConsentStatus) || "unset"; } catch { return "unset"; }
  });
  const [showPreferences, setShowPreferences] = useState(false);
  const [tokens, setTokens] = useState<ConsentValue>({ accepted: false });
  const tracking = useTrackAnalyticsEvent();
  const trackingMutate = useRef(tracking.mutate);
  trackingMutate.current = tracking.mutate;
  const lastTrackedPath = useRef("");
  const attributionRef = useRef<Attribution>({});
  const accepted = status === "accepted";

  useEffect(() => {
    if (!accepted) {
      setTokens({ accepted: false });
      if (status === "rejected") {
        try { localStorage.removeItem(VISITOR_KEY); sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(ATTRIBUTION_KEY); } catch { /* storage may be unavailable */ }
      }
      return;
    }
    try {
      const visitorToken = getToken(localStorage, VISITOR_KEY);
      const sessionToken = getToken(sessionStorage, SESSION_KEY);
      attributionRef.current = currentAttribution();
      setTokens({ accepted: true, visitorToken, sessionToken });
    } catch {
      setTokens({ accepted: false });
    }
  }, [accepted, status]);

  useEffect(() => {
    if (!accepted || !tokens.visitorToken || !tokens.sessionToken) return;
    const pathname = ((path.split("?")[0] || "/").replace(/\/$/, "") || "/").slice(0, 512);
    if (lastTrackedPath.current === pathname) return;
    lastTrackedPath.current = pathname;
    if (pathname === "/admin" || pathname.startsWith("/admin/")) return;
    const attribution = attributionRef.current;
    let referrer: string | undefined;
    try { referrer = document.referrer ? new URL(document.referrer).origin : undefined; } catch { referrer = undefined; }
    const base = { visitorToken: tokens.visitorToken, sessionToken: tokens.sessionToken, path: pathname, ...attribution, referrer };
    trackingMutate.current({ data: { ...base, eventType: "page_view" } });
    if (pathname === "/checkout") trackingMutate.current({ data: { ...base, eventType: "checkout_visit" } });
    if (pathname === "/payment") trackingMutate.current({ data: { ...base, eventType: "payment_page" } });
  }, [accepted, path, tokens]);

  function choose(choice: "accepted" | "rejected") {
    try { localStorage.setItem(CONSENT_KEY, choice); } catch { /* consent still applies in memory */ }
    lastTrackedPath.current = "";
    setStatus(choice);
    setShowPreferences(false);
  }
  return <ConsentContext.Provider value={tokens}>
    {children}
    {status === "unset" || showPreferences ? <aside className="consent-banner" role="dialog" aria-label="Analytics preferences" data-testid="panel-analytics-consent">
      <div className="consent-copy"><span className="bt-kicker"><ShieldCheck size={13}/> Privacy controls</span><strong>{showPreferences ? "Your analytics choice" : "Help us understand campaign performance."}</strong>
        <p>Optional analytics connect campaign links to aggregate visits and verified purchases. Analytics do not include contact or payment details, and IP addresses are not stored.</p>
      </div>
      <div className="consent-actions">
        {showPreferences && <button className="bt-button secondary" type="button" onClick={() => setShowPreferences(false)} data-testid="button-close-privacy">Close</button>}
        <button className="bt-button secondary" type="button" onClick={() => choose("rejected")} data-testid="button-reject-analytics">Reject</button>
        <button className="bt-button" type="button" onClick={() => choose("accepted")} data-testid="button-accept-analytics">Accept analytics</button>
      </div>
    </aside> : <button type="button" className="privacy-control" onClick={() => setShowPreferences(true)} data-testid="button-privacy-preferences"><ShieldCheck size={14}/> Privacy preferences</button>}
  </ConsentContext.Provider>;
}

export function RegisteredUserSync({ isSignedIn, userId }: { isSignedIn: boolean; userId?: string }) {
  const sync = useSyncRegisteredUser();
  const syncMutate = useRef(sync.mutate);
  syncMutate.current = sync.mutate;
  const synced = useRef("");
  useEffect(() => {
    if (!isSignedIn || !userId || synced.current === userId) return;
    synced.current = userId;
    syncMutate.current();
  }, [isSignedIn, userId]);
  return null;
}

const nf = new Intl.NumberFormat("en-US");
function value(n: number) { return nf.format(Number.isFinite(n) ? n : 0); }
function percent(n: number) { return `${(Number(n) || 0).toFixed(1)}%`; }
function LoadingAnalytics() { return <div className="analytics-loading" aria-label="Loading analytics">{[1,2,3,4].map((n)=><div key={n}/>)}</div>; }

export function AnalyticsPanel() {
  const [range, setRange] = useState<"7d"|"30d"|"90d">("30d");
  const summary = useGetAdminAnalytics({ range }, { query: { queryKey: getGetAdminAnalyticsQueryKey({ range }) } });
  const campaignsQuery = useListAdminCampaigns({ query: { queryKey: getListAdminCampaignsQueryKey() } });
  const [name, setName] = useState("");
  const [source, setSource] = useState("email");
  const [medium, setMedium] = useState("email");
  const [notice, setNotice] = useState("");
  const [noticeError, setNoticeError] = useState(false);
  const [copiedId, setCopiedId] = useState("");
  const qc = useQueryClient();
  const createCampaign = useCreateCampaign({ mutation: { onSuccess: async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: getListAdminCampaignsQueryKey() }),
      qc.invalidateQueries({ queryKey: getGetAdminAnalyticsQueryKey() }),
    ]);
  } } });
  const data = summary.data;
  const points = data?.timeSeries ?? [];
  const peak = Math.max(1, ...points.map((point) => point.visits));
  const chart = useMemo(() => points.map((point, index) => ({
    ...point, x: points.length <= 1 ? 50 : index * 100 / (points.length - 1), y: 100 - point.visits / peak * 86,
  })), [points, peak]);
  async function copyLink(campaign: Campaign) {
    try {
      await navigator.clipboard.writeText(campaign.generatedUrl);
      setCopiedId(campaign.id);
      setNotice(`Campaign link copied: ${campaign.name}`);
      setNoticeError(false);
      window.setTimeout(() => setCopiedId(""), 1800);
    } catch { setNotice("Clipboard unavailable. Select and copy the campaign URL."); setNoticeError(true); }
  }
  function submitCampaign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setNotice("");
    createCampaign.mutate({ data: { name: name.trim(), source: source.trim(), medium: medium.trim() } }, {
      onSuccess: (campaign) => { setNotice(`Link created for ${campaign.name}. It is ready to place in an email, PDF, or DOCX.`); setNoticeError(false); setName(""); },
      onError: () => { setNotice("Campaign could not be created. Check the name, source, and channel, then retry."); setNoticeError(true); },
    });
  }
  return <div className="analytics-page">
    <div className="analytics-intro"><div><span className="bt-kicker"><Activity size={13}/> CAMPAIGN INTELLIGENCE</span><h2>From first touch<br/><em>to verified order.</em></h2><p>Measure consented visits and see which external campaign links lead to paid evaluations.</p></div>
      <div className="analytics-range" role="group" aria-label="Analytics time range">{(["7d","30d","90d"] as const).map((item)=><button type="button" key={item} className={range===item?"active":""} onClick={()=>setRange(item)} data-testid={`button-range-${item}`}>{item}</button>)}</div>
    </div>
    {summary.isLoading ? <LoadingAnalytics/> : summary.isError || !data ? <div className="analytics-state"><strong>Analytics could not be loaded.</strong><p>The analytics endpoint may be unavailable or your session may have expired.</p><button className="bt-button secondary" type="button" onClick={()=>void summary.refetch()} data-testid="button-retry-analytics">Retry <RefreshCw size={14}/></button></div> :
      <>
        <section className="analytics-metrics" aria-label="Analytics summary" data-testid="content-analytics-summary">
          {[
            ["Visitors today",data.visitorsToday,"TODAY"],["Visitors this week",data.visitorsThisWeek,"7 DAY ROLLING"],["Visitors this month",data.visitorsThisMonth,"30 DAY ROLLING"],
            ["Total visits",data.totalVisits,"SELECTED RANGE"],["Unique visitors",data.uniqueVisitors,"SELECTED RANGE"],["Returning",data.returningVisitors,"REPEAT VISITORS"],["Registered users",data.registeredUsers,"CLERK SYNC"],
            ["Page views",data.totalPageViews,"SELECTED RANGE"],["Checkouts",data.checkouts,"CHECKOUT VISITS"],["Verified purchases",data.purchases,"PAID ORDERS"],
          ].map(([label,note,caption],i)=><article className={`analytics-metric ${i===8?"highlight":""}`} key={String(label)} data-testid={`metric-analytics-${String(label).toLowerCase().replaceAll(" ","-")}`}><span>{String(caption)}</span><strong>{value(Number(note))}</strong><small>{String(label)}</small></article>)}
          <article className="analytics-metric conversion"><span>ORDER CONVERSION</span><strong>{percent(data.conversionRate)}</strong><small>Verified purchases / visitors</small></article>
        </section>
        <div className="analytics-grid-main">
          <section className="analytics-card trend-card"><div className="analytics-card-head"><div><span className="bt-kicker">VISIT ACTIVITY</span><h3>Traffic over time</h3></div><span className="analytics-unit"><MousePointer2 size={13}/> visits / day</span></div>
            {chart.length ? <div className="chart-wrap"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Visits, unique visitors, and purchases over time" data-testid="chart-visits"><defs><linearGradient id="visit-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#81b698" stopOpacity=".25"/><stop offset="100%" stopColor="#81b698" stopOpacity="0"/></linearGradient></defs><path d={`M ${chart[0].x},100 ${chart.map(p=>`L ${p.x},${p.y}`).join(" ")} L ${chart[chart.length-1].x},100 Z`} fill="url(#visit-fill)"/><polyline className="line-visits" points={chart.map(p=>`${p.x},${p.y}`).join(" ")}/><polyline className="line-unique" points={chart.map(p=>`${p.x},${100-p.uniqueVisitors/peak*86}`).join(" ")}/><polyline className="line-purchases" points={chart.map(p=>`${p.x},${100-p.purchases/peak*86}`).join(" ")}/>{chart.map((p,i)=><circle key={p.date} cx={p.x} cy={p.y} r="1.2" fill="#c2dfcc"><title>{`${p.date}: ${value(p.visits)} visits, ${value(p.uniqueVisitors)} unique, ${value(p.purchases)} purchases`}</title></circle>)}</svg><div className="chart-dates"><span>{points[0]?.date ?? "—"}</span><span>{points[Math.floor(points.length/2)]?.date ?? "—"}</span><span>{points[points.length-1]?.date ?? "—"}</span></div></div> : <div className="analytics-empty">No visit history for this period yet.</div>}
            <div className="trend-legend"><span><i/>Visits</span><span><i className="legend-soft"/>Unique visitors</span><span><i className="legend-gold"/>Paid orders</span></div>
          </section>
          <section className="analytics-card funnel-card"><div className="analytics-card-head"><div><span className="bt-kicker">CONVERSION PATH</span><h3>Visitor to purchase</h3></div><ArrowDownRight size={17}/></div>
            <Funnel data={data}/>
          </section>
        </div>
        <div className="analytics-grid-secondary">
          <section className="analytics-card"><div className="analytics-card-head"><div><span className="bt-kicker">ATTRIBUTION</span><h3>Source channels</h3></div><span className="table-count">{data.channels.length} CHANNELS</span></div>
            {data.channels.length ? <div className="channel-list">{data.channels.map((channel,i)=>{const total=Math.max(1,data.channels.reduce((sum,c)=>sum+c.visits,0));return <div className="channel-row" key={channel.category} data-testid={`row-channel-${channel.category}`}><span className="channel-dot" data-tone={i%4}/><b>{channel.category}</b><div className="channel-track"><i style={{width:`${channel.visits/total*100}%`}}/></div><strong>{value(channel.visits)}</strong><small>{percent(channel.visits/total*100)}</small></div>;})}</div> : <div className="analytics-empty">No channel attribution recorded yet.</div>}
          </section>
          <section className="analytics-card"><div className="analytics-card-head"><div><span className="bt-kicker">ORDER QUALITY</span><h3>Purchase checkpoints</h3></div><ShieldCheck size={16}/></div>
            <div className="checkpoint-list"><Checkpoint label="Payment submissions" n={data.funnel.paymentSubmissions} /><Checkpoint label="Verified paid orders" n={data.funnel.verifiedPurchases} verified /></div>
            <p className="checkpoint-note">Only manually verified paid orders count as purchases.</p>
          </section>
        </div>
        <section className="analytics-card campaign-performance"><div className="analytics-card-head"><div><span className="bt-kicker">CAMPAIGN PERFORMANCE</span><h3>What is working</h3></div><span className="table-count">{data.campaigns.length} TRACKED</span></div>
          {data.campaigns.length ? <div className="campaign-table-scroll"><table className="campaign-table"><thead><tr><th>Campaign</th><th>Source / channel</th><th>Visits</th><th>Unique</th><th>Paid</th><th>Conversion</th></tr></thead><tbody>{data.campaigns.map((campaign,i)=><tr key={`${campaign.campaignName}-${campaign.source}-${i}`} data-testid={`row-performance-${i}`}><td><b>{campaign.campaignName}</b></td><td>{campaign.source}<small>{campaign.medium}</small></td><td>{value(campaign.visits)}</td><td>{value(campaign.uniqueVisitors)}</td><td>{value(campaign.purchases)}</td><td className="conversion-cell">{percent(campaign.conversionRate)}</td></tr>)}</tbody></table></div> : <div className="analytics-empty">Campaign performance appears after consented campaign visits arrive.</div>}
        </section>
        <section className="analytics-card campaign-manager"><div className="analytics-card-head"><div><span className="bt-kicker">LINK BUILDER</span><h3>Campaign links</h3></div><span className="campaign-mark"><ExternalLink size={14}/> UTM READY</span></div>
          <p className="campaign-helper">Create tagged links for newsletter buttons, PDF guides, and DOCX resources. Use the generated URL as the destination; attribution is preserved for this browser session.</p>
          <form className="campaign-form" onSubmit={submitCampaign}>
            <label className="bt-field">Campaign name<input required minLength={2} maxLength={120} value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. March evaluation guide" data-testid="input-campaign-name"/></label>
            <label className="bt-field">Source<input required maxLength={60} value={source} onChange={e=>setSource(e.target.value)} placeholder="newsletter" data-testid="input-campaign-source"/></label>
            <label className="bt-field">Channel / medium<select value={medium} onChange={e=>setMedium(e.target.value)} data-testid="select-campaign-medium"><option value="email">Email</option><option value="pdf">PDF</option><option value="docx">DOCX</option><option value="social">Social</option><option value="other">Other</option></select></label>
            <button className="bt-button" type="submit" disabled={createCampaign.isPending} data-testid="button-create-campaign"><Plus size={15}/>{createCampaign.isPending?"Creating link…":"Create campaign link"}</button>
          </form>
          {notice && <p role={noticeError?"alert":"status"} className={noticeError?"form-error":"campaign-success"} data-testid="status-campaign">{notice}</p>}
          <div className="campaign-links">
            {campaignsQuery.isLoading ? <div className="campaign-skeleton"/> : campaignsQuery.isError ? <div className="analytics-state inline"><span>Campaign links could not be loaded.</span><button className="bt-button secondary" type="button" onClick={()=>void campaignsQuery.refetch()} data-testid="button-retry-campaigns">Retry</button></div> : (campaignsQuery.data ?? []).length ? (campaignsQuery.data ?? []).map(campaign=><CampaignLink key={campaign.id} campaign={campaign} copied={copiedId===campaign.id} onCopy={()=>void copyLink(campaign)}/>) : <div className="analytics-empty campaign-empty"><Users size={17}/><span>No campaign links yet. Create one above to start attributing external traffic.</span></div>}
          </div>
        </section>
        <div className="analytics-footnote"><ShieldCheck size={15}/><span>Only consented pseudonymous analytics are included. Paths are stored without query strings; referrers are reduced to their origin.</span></div>
      </>}
  </div>;
}

function Checkpoint({label,n,verified=false}:{label:string;n:number;verified?:boolean}) {
  return <div className="checkpoint-row"><span className={verified?"checkpoint-verified":""}>{verified?<Check size={13}/>:<ArrowUpRight size={13}/>}</span><div><small>{label}</small><strong>{value(n)}</strong></div></div>;
}
function Funnel({data}:{data:AnalyticsSummary}) {
  const steps=[["Visitors",data.funnel.visitors],["Checkout",data.funnel.checkoutVisits],["Payment page",data.funnel.paymentPages],["Submitted",data.funnel.paymentSubmissions],["Verified paid",data.funnel.verifiedPurchases]] as const;
  const max=Math.max(1,steps[0][1]);
  return <div className="funnel-list">{steps.map(([label,n],i)=><div className="funnel-step" key={label} data-testid={`funnel-step-${i}`}><div className="funnel-step-head"><span><i>0{i+1}</i>{label}</span><strong>{value(n)}</strong></div><div className="funnel-track"><i style={{width:`${Math.max(n>0?5:0,n/max*100)}%`}}/></div><small>{i===0?"100% of tracked visitors":`${percent(n/max*100)} of visitors`}</small></div>)}</div>;
}
function CampaignLink({campaign,copied,onCopy}:{campaign:Campaign;copied:boolean;onCopy:()=>void}) {
  return <article className="campaign-link" data-testid={`campaign-link-${campaign.id}`}><div className="campaign-link-top"><div><b>{campaign.name}</b><span>{campaign.source} / {campaign.medium} · {new Date(campaign.createdAt).toLocaleDateString()}</span></div><button type="button" onClick={onCopy} aria-label={`Copy link for ${campaign.name}`} data-testid={`button-copy-campaign-${campaign.id}`}>{copied?<Check size={14}/>:<Copy size={14}/>} {copied?"Copied":"Copy link"}</button></div><code>{campaign.generatedUrl}</code><div className="campaign-link-stats"><span>{value(campaign.visits)} visits</span><span>{value(campaign.uniqueVisitors)} unique</span><span>{value(campaign.purchases)} paid</span><b>{percent(campaign.conversionRate)} conversion</b></div></article>;
}
