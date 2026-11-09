/** Pinpoint's public postings feed, <company>.pinpointhq.com/postings.json. No auth. It gives no posting date. */
import { z } from "zod";
import { getJson } from "../../util/http.js";
import { decodeEntities, htmlToText } from "../../util/text.js";
import { canonicalUrl, jobId, type Job } from "../../jobs/normalize.js";

const PinpointJob = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  url: z.string(),
  description: z.string().nullable().optional(),
  key_responsibilities: z.string().nullable().optional(),
  skills_knowledge_expertise: z.string().nullable().optional(),
  workplace_type: z.string().nullable().optional(),
  job: z.object({ department: z.object({ name: z.string() }).nullable().optional() }).nullable().optional(),
  location: z.object({ city: z.string().nullable().optional(), name: z.string().nullable().optional(), province: z.string().nullable().optional() }).nullable().optional(),
});
const PinpointFeed = z.object({ data: z.array(z.unknown()) });

/** The company a Pinpoint link belongs to: <company>.pinpointhq.com. */
export function pinpointSlug(url: string): string | null {
  const m = /^https?:\/\/([a-z0-9-]+)\.pinpointhq\.com/i.exec(url);
  return m ? (m[1] as string).toLowerCase() : null;
}

export function parsePinpoint(raw: unknown, slug: string, companyFallback: string): Job[] {
  const feed = PinpointFeed.parse(raw);
  const out: Job[] = [];
  for (const item of feed.data) {
    const p = PinpointJob.safeParse(item);
    if (!p.success) continue;
    const j = p.data;
    // Pinpoint puts the city in `city` and the country, or "Remote/<country>", in `name`.
    const locations = [[j.location?.city, j.location?.name].filter((x) => x && x.trim()).join(", ")].filter(Boolean);
    if (j.workplace_type === "remote" && !locations.some((l) => /remote/i.test(l))) locations.push("Remote");
    const url = canonicalUrl(j.url);
    const description = [j.description, j.key_responsibilities, j.skills_knowledge_expertise].filter((x): x is string => !!x).map(htmlToText).join("\n\n");
    out.push({
      id: jobId(url),
      source: `pinpoint:${slug}`,
      company: companyFallback,
      title: decodeEntities(j.title).trim(),
      url,
      ats: "pinpoint",
      locations,
      postedAt: null,
      terms: [],
      sponsorship: "unknown",
      degrees: [],
      category: j.job?.department?.name ?? null,
      description,
      descriptionSource: description ? "api" : "none",
    });
  }
  return out;
}

export async function fetchPinpointBoard(slug: string, companyFallback: string): Promise<Job[]> {
  const raw = await getJson(`https://${encodeURIComponent(slug)}.pinpointhq.com/postings.json`, { cacheMs: 20 * 60_000 });
  return parsePinpoint(raw, slug, companyFallback);
}
