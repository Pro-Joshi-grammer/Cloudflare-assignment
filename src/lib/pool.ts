// In-memory vector search over the candidate pool; KV is the durable store.
// Embeddings are precomputed at seed time (lib/seed.ts); the query embeds live.
// ponytail: 100 candidates → linear cosine scan in RAM. Swap to Vectorize past ~10k.

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

export interface RawCandidate {
  candidate_id: string;
  profile: {
    anonymized_name: string;
    headline: string;
    summary: string;
    location: string;
    country: string;
    years_of_experience: number;
    current_title: string;
    current_company: string;
    current_company_size: string;
    current_industry: string;
  };
  career_history: {
    company: string;
    title: string;
    start_date: string | null;
    end_date: string | null;
    duration_months: number;
    is_current: boolean;
    industry: string;
    company_size: string;
    description: string;
  }[];
  education: {
    institution: string;
    degree: string;
    field_of_study: string;
    start_year: number;
    end_year: number;
    grade: string;
    tier: string;
  }[];
  skills: string[];
  certifications: unknown[];
  languages: { language: string; proficiency: string }[];
  /** Internal platform signals — never fed to the embedder or the model. */
  redrob_signals?: Record<string, unknown>;
}

interface PoolItem {
  rec: RawCandidate;
  embedding: number[];
}

const MAX_EVIDENCE_CHARS = 1800; // ponytail: trim so the tool result doesn't pad the model context and nudge it into a repeat loop.

/** Compact, resume-shaped text used for BOTH embedding and re-rank evidence. */
export function buildCandidateText(rec: RawCandidate): string {
  const p = rec.profile;
  const recent = rec.career_history.slice(0, 3);
  const certs = rec.certifications
    .map((c) =>
      typeof c === "string"
        ? c
        : ((c as { name?: string })?.name ?? JSON.stringify(c))
    )
    .filter(Boolean);

  const text = [
    `Name: ${p.anonymized_name}`,
    `Headline: ${p.headline}`,
    p.summary,
    `Currently: ${p.current_title} at ${p.current_company} (${p.current_industry}, ${p.current_company_size})`,
    `Location: ${p.location}, ${p.country} | ${p.years_of_experience} years experience`,
    `Skills: ${rec.skills
      .map((s) => (typeof s === "string" ? s : (s as { name?: string })?.name))
      .filter(Boolean)
      .join(", ")}`,
    ...recent.map(
      (c) =>
        `[${c.is_current ? "Current" : "Past"}] ${c.title} @ ${c.company} · ${c.industry} · ${c.duration_months}mo${c.start_date ? ` (${c.start_date}→${c.end_date ?? "now"})` : ""}: ${c.description}`
    ),
    rec.education.length > 0
      ? `Education: ${rec.education.map((e) => `${e.degree} in ${e.field_of_study} @ ${e.institution}`).join("; ")}`
      : "",
    certs.length > 0 ? `Certifications: ${certs.join(", ")}` : "",
    rec.languages.length > 0
      ? `Languages: ${rec.languages.map((l) => `${l.language} (${l.proficiency})`).join(", ")}`
      : ""
  ]
    .filter(Boolean)
    .join("\n");

  return text.length > MAX_EVIDENCE_CHARS
    ? text.slice(0, MAX_EVIDENCE_CHARS) + "\n[…]"
    : text;
}

export async function embedTexts(
  env: Env,
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out = (await env.AI.run(EMBED_MODEL, {
    text: texts,
    pooling: "cls"
  })) as { data?: number[][] };
  return (out.data ?? []) as number[][];
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Module-level cache lives as long as the DO instance does; re-fetched on cold
// start. TTL-bounded (60s) so a re-seed in another isolate (the stateless
// fetch worker, e.g. POST /__seed) reaches live DO instances on their own.
let cached: PoolItem[] | null = null;
let cachedAt = 0;
const POOL_CACHE_TTL_MS = 60_000;

/** Drop the in-memory cache so a re-seed is picked up. */
export function invalidatePool(): void {
  cached = null;
  cachedAt = 0;
}

async function loadPool(env: Env): Promise<PoolItem[]> {
  if (cached && Date.now() - cachedAt < POOL_CACHE_TTL_MS) return cached;
  const list = await env.HIRING_KV.list({ prefix: "candidate:" });
  const items = (
    await Promise.all(
      list.keys.map(
        async (k) => (await env.HIRING_KV.get(k.name, "json")) as unknown
      )
    )
  ).filter(Boolean) as PoolItem[];
  cached = items;
  cachedAt = Date.now();
  return cached;
}

export interface CandidateHit {
  id: string;
  name: string;
  current_title: string;
  headline: string;
  cosine: number;
  evidence_text: string;
}

export async function search(
  env: Env,
  query: string,
  k: number
): Promise<CandidateHit[]> {
  const [items, vectors] = await Promise.all([
    loadPool(env),
    embedTexts(env, [query])
  ]);
  if (!vectors[0]) return [];
  const q = vectors[0];
  return items
    .map(({ rec, embedding }) => ({ rec, score: cosine(embedding, q) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ rec, score }) => ({
      id: rec.candidate_id,
      name: rec.profile.anonymized_name,
      current_title: rec.profile.current_title,
      headline: rec.profile.headline,
      cosine: Math.round(score * 1000) / 1000,
      evidence_text: buildCandidateText(rec)
    }));
}
