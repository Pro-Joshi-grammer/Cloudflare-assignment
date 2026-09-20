// One-time pool population: embeds every candidate with bge-base and writes
// { rec, embedding } plus the JDs into KV. Idempotent (KV put overwrites).
// Invoked via POST /__seed (token-gated) — see server.ts.

import candidatesRaw from "../../100candidates.jsonl?raw";
import mlEngineerRaw from "../../data/jds/ml-engineer.json?raw";
import softwareEngineerRaw from "../../data/jds/software-engineer.json?raw";
import seniorSoftwareEngineerRaw from "../../data/jds/senior-software-engineer.json?raw";
import {
  buildCandidateText,
  embedTexts,
  invalidatePool,
  type RawCandidate
} from "./pool";
import type { JD } from "./jds";

const BATCH = 10;

export async function seed(
  env: Env
): Promise<{ candidates: number; jds: string[] }> {
  const records = candidatesRaw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RawCandidate)
    .filter(Boolean);

  let embedded = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const vectors = await embedTexts(env, batch.map(buildCandidateText));
    await Promise.all(
      batch.map((rec, j) =>
        env.HIRING_KV.put(
          `candidate:${rec.candidate_id}`,
          JSON.stringify({ rec, embedding: vectors[j] })
        )
      )
    );
    embedded += batch.length;
  }

  const jds = [
    mlEngineerRaw,
    softwareEngineerRaw,
    seniorSoftwareEngineerRaw
  ].map((s) => JSON.parse(s) as JD);
  await Promise.all(
    jds.map((jd) => env.HIRING_KV.put(`jd:${jd.slug}`, JSON.stringify(jd)))
  );

  invalidatePool();
  return { candidates: embedded, jds: jds.map((jd) => jd.slug) };
}
