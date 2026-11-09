/**
 * Recruitee's public offers API, <company>.recruitee.com/api/offers/. No auth. A company may show
 * its offers on its own domain (jobs.unifonic.com), so a job's link does not always say Recruitee:
 * the job carries `ats: "recruitee"` from here.
 */
import { z } from "zod";
import { getJson } from "../../util/http.js";
import { decodeEntities, htmlToText } from "../../util/text.js";
import { canonicalUrl, jobId, type Job } from "../../jobs/normalize.js";

const RecruiteeOffer = z.object({
  id: z.number(),
  title: z.string(),
  status: z.string().nullable().optional(),
  careers_url: z.string(),
  careers_apply_url: z.string().nullable().optional(),
  company_name: z.string().nullable().optional(),
  remote: z.boolean().nullable().optional(),
  published_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  requirements: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  locations: z.array(z.object({ city: z.string().nullable().optional(), state: z.string().nullable().optional(), country: z.string().nullable().optional() })).optional(),
});
const RecruiteeFeed = z.object({ offers: z.array(z.unknown()) });

/** The company a recruitee.com link belongs to. A company's own domain names none. */
export function recruiteeSlug(url: string): string | null {
  const m = /^https?:\/\/([a-z0-9-]+)\.recruitee\.com/i.exec(url);
  return m ? (m[1] as string).toLowerCase() : null;
}

export function parseRecruitee(raw: unknown, slug: string, companyFallback: string): Job[] {
  const feed = RecruiteeFeed.parse(raw);
  const out: Job[] = [];
  for (const item of feed.offers) {
    const p = RecruiteeOffer.safeParse(item);
    if (!p.success) continue;
    const o = p.data;
    if (o.status && o.status !== "published") continue;
    const locations = (o.locations?.length ? o.locations : [{ city: o.city ?? null, state: null, country: o.country ?? null }])
      .map((l) => [l.city, l.state, l.country].filter((x) => x && x.trim()).join(", "))
      .filter(Boolean);
    if (o.remote && !locations.some((l) => /remote/i.test(l))) locations.push("Remote");
    const url = canonicalUrl(o.careers_url);
    const description = [o.description, o.requirements].filter((x): x is string => !!x).map(htmlToText).join("\n\n");
    out.push({
      id: jobId(url),
      source: `recruitee:${slug}`,
      company: o.company_name?.trim() || companyFallback,
      title: decodeEntities(o.title).trim(),
      url,
      ats: "recruitee",
      locations: [...new Set(locations)],
      postedAt: (o.published_at ?? o.created_at ?? "").slice(0, 10) || null,
      terms: [],
      sponsorship: "unknown",
      degrees: [],
      category: o.department ?? null,
      description,
      descriptionSource: description ? "api" : "none",
    });
  }
  return out;
}

export async function fetchRecruiteeBoard(slug: string, companyFallback: string): Promise<Job[]> {
  const raw = await getJson(`https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`, { cacheMs: 20 * 60_000 });
  return parseRecruitee(raw, slug, companyFallback);
}
