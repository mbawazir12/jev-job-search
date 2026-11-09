/**
 * Pure-code filters that run before JEV so the model never sees a job we
 * would refuse anyway. Each returns a reason string or null. The reasons
 * end up in the CSV so a skipped job is explainable.
 */
import { COUNTRIES, DISCOVER, LEGACY_TIERS, LOCATION_MULTIPLIER } from "../config.js";
import { ageDays, type Job } from "./normalize.js";
import { isWalled } from "./walled.js";
import type { Profile } from "../profile/schema.js";

const NON_SOFTWARE_TITLE =
  /\b(hardware|mechanical|electrical|civil|chemical|aerospace|manufacturing|industrial|process|structural|rf|asic|fpga|pcb|silicon|analog|mixed[- ]signal|product manager|program manager|project manager|technical program|product design|ux|ui designer|graphic|marketing|sales|recruit|finance intern|accounting|legal|hr |human resources|supply chain|operations analyst|business analyst|data scientist|data science|data analyst|quant|trading|research scientist|phd|postdoc|technician|physical|optics|photonics|materials|biomed|clinical|nurse|teacher)\b/i;

/** A title that matches NON_SOFTWARE_TITLE is rescued when it also says one of these. */
const SOFTWARE_TITLE = /software|developer|programm|full[- ]stack|backend|frontend|front[- ]end|back[- ]end|\bswe\b|web engineer|mobile engineer|platform engineer/i;

const FRENCH_TITLE = /\b(stagiaire|développeur|developpeur|ingénieur|ingenieur|stage\b|alternance|poste)\b/i;

/** Where a job is, relative to the candidate. The meaning of each tier is in LOCATION_MULTIPLIER. */
export type LocationTier = keyof typeof LOCATION_MULTIPLIER;

/**
 * Where the candidate stands, from the profile: the country they live in, the places they want to
 * work, the countries they may work in without sponsorship, and their citizenships. Every country
 * is written the way COUNTRIES names it when the table knows it.
 */
export type Where = { home: string | null; places: string[]; authorized: string[]; citizenOf: string[] };
export const NOWHERE: Where = { home: null, places: [], authorized: [], citizenOf: [] };

/** A country's name as COUNTRIES writes it ("KSA", "Saudi" and "Saudi Arabian" are Saudi Arabia), or the text itself, trimmed, for a country the table does not know. */
export function canonicalCountry(s: string): string {
  const t = s.trim();
  return COUNTRIES.find((c) => c.name.toLowerCase() === t.toLowerCase() || c.names.test(t))?.name ?? t;
}

export const sameCountry = (a: string, b: string): boolean => canonicalCountry(a).toLowerCase() === canonicalCountry(b).toLowerCase();

/** The country a question names by its own name: "Are you a Saudi national?", "authorized to work in the US". Null when it names none. */
export function countryNamedIn(text: string): string | null {
  return COUNTRIES.find((c) => c.names.test(text))?.name ?? null;
}

/** The country a posting's locations name, when one of them does: "San Francisco, Remote" is the United States, "KOHO (CAN), Remote" is Canada, "Riyadh | KSA" is Saudi Arabia. */
export function countryOfLocations(locations: string[]): string | null {
  const all = locations.join(" | ");
  return COUNTRIES.find((c) => c.names.test(all) || c.places?.test(all) || c.codes?.test(all))?.name ?? null;
}

/** True when a place is one the candidate wants to work in: "Riyadh" matches "Riyadh, Riyadh Province". */
const namesPlace = (all: string, place: string): boolean => new RegExp(`(^|[^\\p{L}])${place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "iu").test(all);

/** "Remote in USA" and "Remote/Kazakhstan" are remote inside one country; "San Francisco, Remote" is open remote work. */
function remoteRestricted(locations: string[]): boolean {
  return locations.some((l) => {
    const at = l.toLowerCase().indexOf("remote");
    return at >= 0 && countryOfLocations([l.slice(at + "remote".length)]) !== null;
  });
}

export function locationTier(locations: string[], where: Where = NOWHERE): LocationTier {
  const all = locations.join(" | ");
  if (all.trim() === "") return "unclear";
  if (where.places.some((p) => namesPlace(all, p))) return "local";
  const country = countryOfLocations(locations);
  const remote = /remote/i.test(all);
  if (country) {
    if (where.home && sameCountry(country, where.home)) return "home";
    if (where.authorized.some((c) => sameCountry(c, country))) return "authorized";
  }
  if (remote && !remoteRestricted(locations)) return "remote";
  if (country) return "abroad";
  // A place the table does not know: JEV reads the posting and says where it is.
  return remote ? "remote" : "unclear";
}

/** The candidate's standing, from the profile. The places are the cities in preferredLocations, or the home city when none is named. */
export function whereOf(profile: Pick<Profile, "address" | "preferences" | "workAuthorization">): Where {
  const isCountry = (p: string) => COUNTRIES.some((c) => c.name.toLowerCase() === p.toLowerCase()) || /^(KSA|UAE|USA?|UK)$/i.test(p);
  const cities = profile.preferences.preferredLocations
    .map((p) => (p.split(",")[0] ?? "").trim())
    .filter((p) => p && !/^(remote|anywhere|hybrid|on-?site)$/i.test(p) && !isCountry(p));
  const places = cities.length ? cities : profile.address.city.trim() ? [profile.address.city.trim()] : [];
  return {
    home: profile.address.country.trim() ? canonicalCountry(profile.address.country) : null,
    places: [...new Set(places)],
    authorized: profile.workAuthorization.authorizedCountries.map(canonicalCountry),
    citizenOf: profile.workAuthorization.citizenships.map(canonicalCountry),
  };
}

/** A tier written by this version or an earlier one, as this version names it. */
export function normalizeTier(t: string | undefined): LocationTier {
  if (!t) return "unclear";
  if (t in LOCATION_MULTIPLIER) return t as LocationTier;
  return LEGACY_TIERS[t] ?? "unclear";
}

/** May the candidate work in this country without sponsorship, and are they one of its citizens. */
export function statusIn(where: Where, country: string): { authorized: boolean; citizen: boolean } {
  return { authorized: where.authorized.some((c) => sameCountry(c, country)), citizen: where.citizenOf.some((c) => sameCountry(c, country)) };
}

/** us: the candidate's standing in the United States. A candidate who may work there is not ruled out by "no sponsorship". */
export function preFilter(
  job: Job,
  now = new Date(),
  walled: (url: string) => boolean = isWalled,
  us: { authorized: boolean; citizen: boolean } = { authorized: false, citizen: false },
  maxAgeDays: number = DISCOVER.maxAgeDays,
  /** True for a job on an account board where the person has an account, or let the tool make one. */
  mayApplyWithAccount: (url: string) => boolean = () => false,
): string | null {
  if (job.ats === "workday" && !mayApplyWithAccount(job.url)) return "workday (needs an account per company)";
  if (job.ats === "taleo" || job.ats === "oracle" || job.ats === "successfactors" || job.ats === "icims" || job.ats === "amazon") {
    return `${job.ats} (needs an account)`;
  }
  if (walled(job.url)) return "careers site needs an account";
  if ((DISCOVER.unreadableAts as readonly string[]).includes(job.ats)) return `${job.ats} (its form cannot be read yet)`;
  const age = ageDays(job, now);
  if (age !== null && age > maxAgeDays) return `posted ${age} days ago`;
  if (NON_SOFTWARE_TITLE.test(job.title) && !SOFTWARE_TITLE.test(job.title)) {
    return "title is not a software role";
  }
  if (FRENCH_TITLE.test(job.title)) return "non-English posting";
  if (job.degrees.length && !job.degrees.some((d) => /bachelor|associate|bootcamp|certificate/i.test(d))) {
    return "advanced degree required";
  }
  // The lists' sponsorship flags are about the United States. A posting that is also open to remote work elsewhere is not ruled out by them.
  const usRole = countryOfLocations(job.locations) === "United States" && locationTier(job.locations) === "abroad";
  if (usRole && job.sponsorship === "none" && !us.authorized) return "US role, no sponsorship";
  if (usRole && job.sponsorship === "citizenship" && !us.citizen) return "US citizenship required";
  if (/\bunpaid\b|volunteer/i.test(job.title)) return "unpaid";
  return null;
}
