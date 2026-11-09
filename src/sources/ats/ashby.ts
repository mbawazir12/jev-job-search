/** Ashby public job board API. No auth. */
import { z } from "zod";
import { getJson } from "../../util/http.js";
import { canonicalUrl, jobId, type Job } from "../../jobs/normalize.js";

const AshbyJob = z.object({
  id: z.string(),
  title: z.string(),
  jobUrl: z.string(),
  applyUrl: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  secondaryLocations: z.array(z.object({ location: z.string().nullable().optional() })).nullable().optional(),
  employmentType: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  isListed: z.boolean().nullable().optional(),
  isRemote: z.boolean().nullable().optional(),
  workplaceType: z.string().nullable().optional(),
  descriptionPlain: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
});
const AshbyBoard = z.object({ jobs: z.array(z.unknown()) });

export function ashbySlug(url: string): string | null {
  const m = /jobs\.ashbyhq\.com\/([^/?#]+)/i.exec(url);
  return m ? decodeURIComponent(m[1] as string) : null;
}

export function ashbyJobId(url: string): string | null {
  const m = /jobs\.ashbyhq\.com\/[^/]+\/([0-9a-f-]{36})/i.exec(url);
  return m ? (m[1] as string) : null;
}

export async function fetchAshbyBoard(slug: string, companyFallback: string): Promise<Job[]> {
  const raw = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`, { cacheMs: 20 * 60_000 });
  const board = AshbyBoard.safeParse(raw);
  if (!board.success) return [];
  const out: Job[] = [];
  for (const item of board.data.jobs) {
    const p = AshbyJob.safeParse(item);
    if (!p.success) continue;
    const j = p.data;
    if (j.isListed === false) continue;
    const url = canonicalUrl(j.jobUrl);
    const locations = [...new Set([j.location ?? "", ...(j.secondaryLocations ?? []).map((s) => s.location ?? "")].filter(Boolean))];
    if (j.isRemote && !locations.some((l) => /remote/i.test(l))) locations.push("Remote");
    out.push({
      id: jobId(url),
      source: `ashby:${slug}`,
      company: companyFallback,
      title: j.title.trim(),
      url,
      ats: "ashby",
      locations,
      postedAt: j.publishedAt ? j.publishedAt.slice(0, 10) : null,
      terms: [],
      sponsorship: "unknown",
      degrees: [],
      category: j.department ?? null,
      description: j.descriptionPlain ?? "",
      descriptionSource: j.descriptionPlain ? "api" : "none",
    });
  }
  return out;
}

/** Ashby has no per-job endpoint without auth; the board listing carries full descriptions. */
export async function fetchAshbyJob(slug: string, id: string, companyFallback = ""): Promise<string | null> {
  try {
    const jobs = await fetchAshbyBoard(slug, companyFallback);
    return jobs.find((j) => j.url.includes(id))?.description ?? null;
  } catch {
    return null;
  }
}
