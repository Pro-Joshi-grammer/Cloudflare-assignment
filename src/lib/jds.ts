// Precomputed job descriptions, stored as JSON in KV (`jd:{slug}`).

export interface JD {
  slug: string;
  title: string;
  summary: string;
  must_have: string[];
  nice_to_have: string[];
}

/** Canonical titles the floating buttons / model should use. */
export const JD_TITLES = [
  "ML Engineer",
  "Software Engineer",
  "Senior Software Engineer"
];

export function jdSlug(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || ""
  );
}

/** The text form used to embed a JD for retrieval and given to the model as reference. */
export function jdText(jd: JD): string {
  return [
    jd.title,
    jd.summary,
    `Must-have: ${jd.must_have.join(", ")}`,
    `Nice-to-have: ${jd.nice_to_have.join(", ")}`
  ].join("\n");
}

export async function getJD(env: Env, slug: string): Promise<JD | null> {
  const raw = await env.HIRING_KV.get(`jd:${slug}`, "json");
  return (raw as JD) ?? null;
}

export async function listJDs(env: Env): Promise<JD[]> {
  const list = await env.HIRING_KV.list({ prefix: "jd:" });
  const jds = await Promise.all(
    list.keys.map(
      (k) => env.HIRING_KV.get(k.name, "json") as Promise<JD | null>
    )
  );
  return jds.filter((j): j is JD => j !== null);
}
