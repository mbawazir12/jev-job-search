import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProfileSchema, type Profile } from "../src/profile/schema.js";
import { valueFor } from "../src/profile/fieldKeys.js";
import { canonicalCountry, countryNamedIn, countryOfLocations, locationTier, whereOf } from "../src/jobs/hardFilters.js";
import { fitQuestions, scoreFromAnswers } from "../src/jobs/rate.js";
import { authForCountry, categoryOf, gateAnswer, valueForJob } from "../src/forms/mapForm.js";
import { applyUrlFor, atsFromUrl, type Job } from "../src/jobs/normalize.js";
import { isEarlyCareerTitle, readsNorthAmericanLists } from "../src/discover.js";
import { boardsFromJobs } from "../src/sources/companies.js";
import { parseWorkable, workableSlug } from "../src/sources/ats/workable.js";
import { parsePinpoint } from "../src/sources/ats/pinpoint.js";
import { parseRecruitee } from "../src/sources/ats/recruitee.js";
import { exeInShim, opener } from "../src/util/platform.js";
import type { Answer } from "../src/jev/types.js";
import type { DumpedField } from "../src/forms/fields.js";

const example = JSON.parse(readFileSync(new URL("../data/profile.example.json", import.meta.url), "utf8"));
/** The example profile moved to Riyadh, with the citizenship given. */
function saudiProfile(citizen: boolean, iqama?: { holder: boolean; transferable?: boolean }): Profile {
  return ProfileSchema.parse({
    ...example,
    phone: { national: "501234567", countryCode: "+966" },
    address: { line1: "1 Example Road", city: "Riyadh", region: "Riyadh Province", regionCode: "01", postalCode: "12345", country: "Saudi Arabia", countryCode: "SA" },
    workAuthorization: {
      citizenships: citizen ? ["Saudi Arabia"] : ["Egypt"],
      authorizedCountries: ["Saudi Arabia"],
      requiresSponsorshipElsewhere: true,
      statement: citizen ? "Saudi national." : "Egyptian citizen living in Riyadh with a transferable Iqama.",
      ...(iqama ? { iqama } : {}),
    },
    preferences: { ...example.preferences, preferredLocations: ["Riyadh", "Saudi Arabia", "Remote"] },
  });
}
const saudi = saudiProfile(true);
const expat = saudiProfile(false, { holder: true, transferable: true });

const job = (locations: string[], over: Partial<Job> = {}): Job => ({ id: "j", source: "t", company: "Acme", title: "Software Engineer Intern", url: "https://x", ats: "greenhouse", locations, postedAt: "2026-11-08", terms: [], sponsorship: "unknown", degrees: [], category: null, ...over });
const field = (over: Partial<DumpedField>): DumpedField => ({ id: "f0", widget: "", selector: "#x", kind: "text", name: "", label: "", hint: "", placeholder: "", required: false, value: "", options: [], accept: "", maxLength: null, autocomplete: "", buttonGroup: false, section: "", ...over });

describe("countries", () => {
  it.each([
    [["Riyadh, Saudi Arabia"], "Saudi Arabia"],
    [["Riyadh | KSA"], "Saudi Arabia"],
    [["Jeddah, Makkah Province"], "Saudi Arabia"],
    [["Al Khobar"], "Saudi Arabia"],
    [["NEOM"], "Saudi Arabia"],
    [["الرياض"], "Saudi Arabia"],
    [["Dubai, UAE"], "United Arab Emirates"],
    [["Cairo, Egypt"], "Egypt"],
    [["Toronto, ON"], "Canada"],
    [["Austin, TX"], "United States"],
    [["London, ON"], "Canada"],
    [["London, UK"], "United Kingdom"],
  ])("%j is in %s", (locs, country) => {
    expect(countryOfLocations(locs)).toBe(country);
  });
  it("does not read Ontario into 'On-site' or Canada into 'can'", () => {
    expect(countryOfLocations(["Riyadh (On-site)"])).toBe("Saudi Arabia");
    expect(countryOfLocations(["Hybrid (On-site 3 days)"])).toBeNull();
    expect(countryOfLocations(["Remote, can be anywhere"])).toBeNull();
  });
  it("writes a country one way, however the profile spells it", () => {
    expect(canonicalCountry("KSA")).toBe("Saudi Arabia");
    expect(canonicalCountry("Saudi Arabian")).toBe("Saudi Arabia");
    expect(canonicalCountry("U.S.")).toBe("United States");
    expect(canonicalCountry("Narnia")).toBe("Narnia");
  });
  it("reads the country a question names, and not 'us' in 'work with us'", () => {
    expect(countryNamedIn("Are you a Saudi national?")).toBe("Saudi Arabia");
    expect(countryNamedIn("Are you legally authorized to work in the US?")).toBe("United States");
    expect(countryNamedIn("Are you legally authorized to work with us?")).toBeNull();
  });
});

describe("where a Saudi job ranks", () => {
  it("puts Riyadh first, the rest of the Kingdom next, and other countries last", () => {
    const w = whereOf(saudi);
    expect(w).toMatchObject({ home: "Saudi Arabia", places: ["Riyadh"], authorized: ["Saudi Arabia"], citizenOf: ["Saudi Arabia"] });
    expect(locationTier(["Riyadh, Saudi Arabia"], w)).toBe("local");
    expect(locationTier(["Jeddah, Saudi Arabia"], w)).toBe("home");
    expect(locationTier(["Riyadh (On-site)"], w)).toBe("local");
    expect(locationTier(["Dubai, UAE"], w)).toBe("abroad");
    expect(locationTier(["Remote"], w)).toBe("remote");
    expect(locationTier(["Remote/Egypt"], w)).toBe("abroad");
  });
  it("words the location question for the candidate", () => {
    const q = JSON.stringify(fitQuestions(saudi).location_tier);
    expect(q).toContain("Riyadh");
    expect(q).toContain("Elsewhere in Saudi Arabia");
    expect(q).not.toContain("Vancouver");
  });
});

function answers(over: Record<string, Partial<Answer>> = {}): Record<string, Answer> {
  const base: Record<string, Answer> = {
    is_software_role: { type: "noul", noul: 0.98 },
    level: { type: "choice", choice: "internship", probabilities: {}, confidence: 1 },
    is_unpaid: { type: "noul", noul: 0.02 },
    needs_advanced_degree: { type: "noul", noul: 0.02 },
    work_auth: { type: "choice", choice: "open", probabilities: {}, confidence: 1 },
    term: { type: "choice", choice: "summer", probabilities: {}, confidence: 1 },
    graduation_excluded: { type: "noul", noul: 0.05 },
    returning_student_required: { type: "noul", noul: 0.2 },
    stack_match: { type: "score", score: 3, legend: {}, probabilities: {}, confidence: 0.8 },
    experience_match: { type: "score", score: 3, legend: {}, probabilities: {}, confidence: 0.8 },
    location_tier: { type: "choice", choice: "unclear", probabilities: {}, confidence: 1 },
    interview_practical: { type: "noul", noul: 0.3 },
    callback_likelihood: { type: "score", score: 3, legend: { "3": "Likely" }, probabilities: {}, confidence: 0.7 },
    needs_account: { type: "noul", noul: 0.1 },
    requires_references: { type: "noul", noul: 0.05 },
  };
  for (const [k, v] of Object.entries(over)) base[k] = { ...(base[k] as Answer), ...v } as Answer;
  return base;
}

describe("Saudi nationals only", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  const tamheer = job(["Jeddah, Saudi Arabia"], { title: "Software Engineer (Tamheer)" });
  const nationalsOnly = answers({ work_auth: { choice: "nationals_only", confidence: 0.9 } });
  it("skips a nationals-only posting for a candidate who is not Saudi", () => {
    expect(scoreFromAnswers(tamheer, nationalsOnly, now, whereOf(expat)).skipReason).toMatch(/Saudi Arabia citizenship or nationality required/);
  });
  it("keeps it for a Saudi national", () => {
    expect(scoreFromAnswers(tamheer, nationalsOnly, now, whereOf(saudi)).decision).toBe("apply");
  });
  it("keeps a no-sponsorship posting for anyone allowed to work in the Kingdom", () => {
    const noSponsor = answers({ work_auth: { choice: "no_sponsorship", confidence: 0.9 } });
    expect(scoreFromAnswers(tamheer, noSponsor, now, whereOf(expat)).skipReason).toBeNull();
  });
  it("ranks a Riyadh job above the same job in Dubai", () => {
    const riyadh = scoreFromAnswers(job(["Riyadh, Saudi Arabia"]), answers(), now, whereOf(saudi)).score;
    const dubai = scoreFromAnswers(job(["Dubai, UAE"]), answers({ work_auth: { choice: "sponsors" } }), now, whereOf(saudi)).score;
    expect(riyadh).toBeGreaterThan(dubai);
  });
});

describe("Saudi form questions", () => {
  const riyadhJob = job(["Riyadh, Saudi Arabia"]);
  const national = field({ kind: "radio", label: "Are you a Saudi national?", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] as never });
  it("checks a nationality yes or no against the citizenships", () => {
    expect(categoryOf(national)).toBe("nationality");
    expect(gateAnswer(national, "Yes", saudi, riyadhJob)).toBeNull();
    expect(gateAnswer(national, "No", saudi, riyadhJob)).toMatch(/does not match the profile/);
    expect(gateAnswer(national, "Yes", expat, riyadhJob)).toMatch(/does not match the profile/);
    expect(gateAnswer(national, "No", expat, riyadhJob)).toBeNull();
  });
  it("leaves a nationality box that takes a country to the citizenships", () => {
    expect(gateAnswer(field({ label: "Nationality" }), "Egypt", expat, job([]))).toBeNull();
  });
  it("does not treat 'citizen or resident' as citizenship alone", () => {
    expect(categoryOf(field({ kind: "radio", label: "Are you a Saudi citizen or Iqama resident?" }))).not.toBe("nationality");
  });
  it("answers the right to work in the Kingdom from the profile, however the country is written", () => {
    const ksaOnly = ProfileSchema.parse({ ...saudi, workAuthorization: { ...saudi.workAuthorization, authorizedCountries: ["KSA"] } });
    expect(authForCountry(ksaOnly, "Saudi Arabia")).toEqual({ authorized: "Yes", requires_sponsorship: "No" });
    expect(valueForJob(saudi, riyadhJob, "authorized_to_work", "Are you authorized to work in this country?")).toBe("Yes");
    // "with us" is not the United States: the posting's country is used.
    expect(valueForJob(saudi, riyadhJob, "authorized_to_work", "Are you legally authorized to work with us?")).toBe("Yes");
    expect(valueForJob(expat, riyadhJob, "citizen_of_job_country", "Are you a Saudi national?")).toBe("No");
  });
  it("reads the Iqama from the profile and never invents one", () => {
    expect(valueFor(expat, "iqama_holder")).toBe("Yes");
    expect(valueFor(expat, "iqama_transferable")).toBe("Yes");
    expect(valueFor(saudi, "iqama_holder")).toBeNull();
    expect(valueFor(saudiProfile(false, { holder: true }), "iqama_transferable")).toBeNull();
  });
});

describe("Saudi job sources", () => {
  it("counts Tamheer, co-op, trainee and program titles as early career", () => {
    for (const t of ["UX Writer (Tamheer)", "Software Engineering Coop", "IT Trainee", "Tamara Builders Program", "Graduate Development Program 2027", "متدرب تطوير برمجيات"]) expect(isEarlyCareerTitle(t)).toBe(true);
    expect(isEarlyCareerTitle("Senior Backend Engineer")).toBe(false);
  });
  it("skips the US and Canadian lists for a candidate who lives elsewhere", () => {
    expect(readsNorthAmericanLists(saudi)).toBe(false);
    expect(readsNorthAmericanLists(ProfileSchema.parse(example))).toBe(true);
    expect(readsNorthAmericanLists(saudi, "always")).toBe(true);
  });
  it("reads a Workable account and merges a job listed once per city", () => {
    const raw = { name: "Salla", jobs: [
      { title: "Backend Engineer (Tamheer)", shortcode: "AB12", url: "https://apply.workable.com/j/AB12", published_on: "2026-11-01", country: "Saudi Arabia", city: "Jeddah", state: "Makkah Province", locations: [{ country: "Saudi Arabia", city: "Jeddah", region: "Makkah Province" }], description: "<p>Build things.</p>" },
      { title: "Backend Engineer (Tamheer)", shortcode: "AB12", url: "https://apply.workable.com/j/AB12", published_on: "2026-11-01", country: "Saudi Arabia", city: "Riyadh", state: "Riyadh Province", locations: [{ country: "Saudi Arabia", city: "Riyadh", region: "Riyadh Province" }] },
    ] };
    const jobs = parseWorkable(raw, "salla", "Salla");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ company: "Salla", ats: "workable", postedAt: "2026-11-01", source: "workable:salla" });
    expect(jobs[0]?.locations).toEqual(["Jeddah, Makkah Province, Saudi Arabia", "Riyadh, Riyadh Province, Saudi Arabia"]);
    expect(jobs[0]?.description).toContain("Build things.");
    expect(applyUrlFor(jobs[0] as Job)).toBe("https://apply.workable.com/j/AB12/apply");
    expect(boardsFromJobs(jobs, [])).toEqual([{ ats: "workable", slug: "salla", company: "Salla" }]);
    expect(workableSlug("https://apply.workable.com/foodics/j/CD34")).toBe("foodics");
    expect(workableSlug("https://apply.workable.com/j/CD34")).toBeNull();
  });
  it("reads a Pinpoint feed", () => {
    const raw = { data: [{ id: "1", title: "iOS Engineer (Saudi National)", url: "https://tabby.pinpointhq.com/en/postings/53c2f99c", description: "<p>Ship it.</p>", workplace_type: "onsite", job: { department: { name: "Engineering" } }, location: { city: "Riyadh", name: "KSA" } }] };
    const [j] = parsePinpoint(raw, "tabby", "Tabby");
    expect(j).toMatchObject({ ats: "pinpoint", company: "Tabby", locations: ["Riyadh, KSA"], postedAt: null, category: "Engineering" });
    expect(countryOfLocations(j?.locations ?? [])).toBe("Saudi Arabia");
    expect(atsFromUrl("https://tabby.pinpointhq.com/en/postings/53c2f99c")).toBe("pinpoint");
  });
  it("reads Recruitee offers on a company's own domain", () => {
    const raw = { offers: [
      { id: 1, title: "Software Engineer", status: "published", careers_url: "https://jobs.unifonic.com/o/software-engineer", company_name: "Unifonic", remote: false, published_at: "2026-10-01 08:06:32 UTC", locations: [{ city: "Riyadh", state: "Riyadh Province", country: "Saudi Arabia" }], description: "<p>Messaging.</p>" },
      { id: 2, title: "Old", status: "closed", careers_url: "https://jobs.unifonic.com/o/old" },
    ] };
    const jobs = parseRecruitee(raw, "unifonic", "Unifonic");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ats: "recruitee", postedAt: "2026-10-01", locations: ["Riyadh, Riyadh Province, Saudi Arabia"] });
  });
});

describe("Windows", () => {
  it("opens files and links without a shell", () => {
    expect(opener("C:\\a b\\resume.pdf", "win32")).toEqual({ command: "explorer.exe", args: ["C:\\a b\\resume.pdf"] });
    expect(opener("/tmp/x.pdf", "darwin").command).toBe("/usr/bin/open");
  });
  it("finds the program an npm shim starts", () => {
    expect(exeInShim('"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*')).toBe("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
    expect(exeInShim("@echo off")).toBeNull();
  });
});
