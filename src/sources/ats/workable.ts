/**
 * Workable's public job widget. No auth. One account lists a job once per city it is open in,
 * under one shortcode, so the rows are merged into one job with every city.
 */
import { z } from "zod";
import { getJson } from "../../util/http.js";
import { decodeEntities, htmlToText } from "../../util/text.js";
import { canonicalUrl, jobId, type Job } from "../../jobs/normalize.js";

const WorkableJob = z.object({
  title: z.string(),
  shortcode: z.string(),
  url: z.string(),
  telecommuting: z.boolean().nullable().optional(),
  department: z.string().nullable().optional(),
  published_on: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  locations: z.array(z.object({ country: z.string().nullable().optional(), city: z.string().nullable().optional(), region: z.string().nullable().optional(), hidden: z.boolean().optional() })).optional(),
  description: z.string().nullable().optional(),
});
const WorkableAccount = z.object({ name: z.string().optional(), jobs: z.array(z.unknown()) });

/** The account a Workable link belongs to: apply.workable.com/<account>/j/<code>. The short link apply.workable.com/j/<code> names none. */
export function workableSlug(url: string): string | null {
  const m = /apply\.workable\.com\/([^/?#]+)/i.exec(url);
  const slug = m?.[1];
  return slug && slug !== "j" && slug !== "api" ? decodeURIComponent(slug) : null;
}

const place = (l: { city?: string | null | undefined; region?: string | null | undefined; country?: string | null | undefined }) => [l.city, l.region, l.country].filter((x) => x && x.trim()).join(", ");

export function parseWorkable(raw: unknown, slug: string, companyFallback: string): Job[] {
  const account = WorkableAccount.parse(raw);
  const byCode = new Map<string, Job>();
  for (const item of account.jobs) {
    const p = WorkableJob.safeParse(item);
    if (!p.success) continue;
    const j = p.data;
    const locations = [
      ...(j.locations ?? []).filter((l) => !l.hidden).map(place),
      place({ city: j.city ?? null, region: j.state ?? null, country: j.country ?? null }),
      ...(j.telecommuting ? ["Remote"] : []),
    ].filter(Boolean);
    const seen = byCode.get(j.shortcode);
    if (seen) {
      seen.locations = [...new Set([...seen.locations, ...locations])];
      continue;
    }
    const url = canonicalUrl(j.url);
    const description = j.description ? htmlToText(j.description) : "";
    byCode.set(j.shortcode, {
      id: jobId(url),
      source: `workable:${slug}`,
      company: account.name?.trim() || companyFallback,
      title: decodeEntities(j.title).trim(),
      url,
      ats: "workable",
      locations: [...new Set(locations)],
      postedAt: (j.published_on ?? j.created_at ?? "").slice(0, 10) || null,
      terms: [],
      sponsorship: "unknown",
      degrees: [],
      category: j.department ?? null,
      description,
      descriptionSource: description ? "api" : "none",
    });
  }
  return [...byCode.values()];
}

export async function fetchWorkableBoard(slug: string, companyFallback: string): Promise<Job[]> {
  const raw = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`, { cacheMs: 20 * 60_000 });
  return parseWorkable(raw, slug, companyFallback);
}
