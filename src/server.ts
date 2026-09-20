import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  generateObject,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import { getJD, JD_TITLES, jdSlug, jdText, listJDs, type JD } from "./lib/jds";
import { search, type CandidateHit } from "./lib/pool";
import { seed } from "./lib/seed";

/** Last user text across model messages (handles string or part-array content). */
function lastUserMessageText(
  messages: Array<{ role?: string; content?: unknown }>
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const text = c
        .filter(
          (p): p is { type: "text"; text: string } =>
            (p as { type?: string })?.type === "text" &&
            typeof (p as { text?: unknown })?.text === "string"
        )
        .map((p) => p.text)
        .join(" ");
      if (text) return text;
    }
  }
  return "";
}

// ── Structured shortlist schema ────────────────────────────────────────
// Pydantic-class equivalent for this stack: Zod schema + generateObject.
// The model is FORCED into this shape; ai validates the output and re-prompts
// on any non-compliance, so the UI always gets clean rank/name/category/title/
// evidence blocks instead of stuttering free-form prose.

const shortlistCategory = z.enum([
  "VERY STRONG MATCH",
  "STRONG MATCH",
  "PARTIAL MATCH",
  "NOT SUITABLE"
]);

/** One candidate's classification — tiny JSON per call, so fp8-fast can't
 *  truncate the giant multi-candidate object and fail schema validation. */
export const candidateSchema = z.object({
  name: z.string().describe("Candidate name, from the retrieved profile"),
  category: shortlistCategory.describe(
    "Exactly one classification bucket against the role criteria"
  ),
  title: z
    .string()
    .describe("Candidate's current title, with headline if short"),
  evidence: z
    .array(z.string().max(180))
    .min(1)
    .max(2)
    .describe(
      "1-2 concrete evidence bullets paraphrased ONLY from the profile's career/projects/skills/certifications. For NOT SUITABLE candidates, one line stating why instead."
    )
});

interface Shortlist {
  summary: string;
  candidates: (z.infer<typeof candidateSchema> & { rank: number })[];
}

/** Classify each retrieved candidate in PARALLEL — one small generateObject
 *  per candidate (short JSON, under any token ceiling) — then compute the
 *  summary from the category counts. Schema validation still force-complies,
 *  and a per-candidate failure degrades to a review-needed card instead of
 *  killing the whole shortlist. */
async function classifyShortlist(
  env: Env,
  jd: JD | null,
  query: string,
  hits: CandidateHit[]
): Promise<Shortlist> {
  const workersai = createWorkersAI({ binding: env.AI });
  const model = workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  const criteria = jd
    ? `Role: ${jd.title}\nMust-have: ${jd.must_have.join("; ")}\nNice-to-have: ${jd.nice_to_have.join("; ")}`
    : `Role requirements (the user's own words):\n${query}`;

  const system = `You are a senior technical recruiter's AI shortlister. Classify the single candidate below against the role criteria into exactly one bucket:
- VERY STRONG MATCH: meets most must-haves with direct, current evidence
- STRONG MATCH: meets a solid subset of must-haves
- PARTIAL MATCH: some overlap but meaningful gaps
- NOT SUITABLE: little to no overlap

Use ONLY facts present in the candidate's evidence; never invent companies, roles, projects, or certifications. For NOT SUITABLE candidates, write a one-line reason as the single evidence item. Keep evidence SHORT: at most 2 bullets, each under 150 characters — brevity is mandatory.`;

  const promptsFor = (hit: CandidateHit, i: number, retry: boolean) =>
    retry
      ? `To recap — you classify the candidate below and reply with the JSON shape {name, category, title, evidence[]}. The evidence array: exactly 1 item, at most 120 characters. Do not include any other text, no trailing explanation.\n\n${criteria}\n\n${hit.evidence_text}`
      : `${criteria}\n\nCANDIDATE ${i + 1} OF ${hits.length} — verbatim profile evidence:\n\n${hit.evidence_text}`;

  const classifyOne = async (hit: CandidateHit, i: number) => {
    const opts = (retry: boolean) => ({
      model,
      schema: candidateSchema,
      system,
      messages: [{ role: "user" as const, content: promptsFor(hit, i, retry) }]
    });
    try {
      const { object } = await generateObject(opts(false));
      return { rank: i + 1, ...object };
    } catch (error) {
      console.error(
        `candidate ${i + 1} classification failed (retrying once):`,
        error instanceof Error ? error.message : String(error)
      );
      try {
        const { object } = await generateObject(opts(true));
        return { rank: i + 1, ...object };
      } catch (retryError) {
        console.error(
          `candidate ${i + 1} retry also failed:`,
          retryError instanceof Error ? retryError.message : String(retryError)
        );
        return {
          rank: i + 1,
          name: hit.name,
          category: "PARTIAL MATCH" as const,
          title: hit.current_title,
          evidence: [
            "Automatic classification failed — a reviewer should check this profile manually."
          ]
        };
      }
    }
  };

  const classified = await Promise.all(
    hits.map((hit, i) => classifyOne(hit, i))
  );

  // Display order = match strength, not retrieval (cosine) order: a
  // NOT SUITABLE candidate whose title merely resembles the JD must not
  // outrank a STRONG one. Stable so ties keep the similarity order.
  const CATEGORY_RANK: Record<string, number> = {
    "VERY STRONG MATCH": 0,
    "STRONG MATCH": 1,
    "PARTIAL MATCH": 2,
    "NOT SUITABLE": 3
  };
  const candidates = [...classified]
    .sort((a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category])
    .map((c, i) => ({ ...c, rank: i + 1 }));

  const count = (c: z.infer<typeof shortlistCategory>) =>
    candidates.filter((x) => x.category === c).length;
  const summary = `Top candidates for ${jd ? `the ${jd.title} JD` : "your requirements"}: ${count("VERY STRONG MATCH")} very strong, ${count("STRONG MATCH")} strong, ${count("PARTIAL MATCH")} partial, ${count("NOT SUITABLE")} not suitable.`;

  return { summary, candidates };
}

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;

  // Guards against Llama fp8-fast re-calling the same retrieval within one
  // turn (same args → same result → it repeats the answer forever). Reset per
  // user message; the first call runs, any identical repeat just gets told so.
  private shortlistSig: string | null = null;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    this.shortlistSig = null;
    const workersai = createWorkersAI({ binding: this.env.AI });

    const system = `You are a senior technical recruiter's AI shortlister working against a company's internal talent pool of 100 candidate profiles. You help recruiters find and shortlist candidates before a job is posted externally.

How to work:
1. When the user picks a precomputed JD (ML Engineer, Software Engineer, Senior Software Engineer) or describes their own requirements, call the \`shortlistCandidates\` tool. Pass \`jdTitle\` (exactly "ML Engineer", "Software Engineer", or "Senior Software Engineer") when the user references one of those three roles. Otherwise pass the user's own requirements verbatim as \`query\`. ALWAYS include one of the two — never call the tool without either. If the user hasn't given you enough to search on, ask them a clarifying question instead of calling the tool with empty arguments. Retrieve 5 candidates by default; retrieve more when the user asks for more.
2. The tool returns a complete, schema-valid shortlist: each candidate already has its rank, classification bucket (VERY STRONG MATCH / STRONG MATCH / PARTIAL MATCH / NOT SUITABLE), title, and evidence bullets.
3. After the tool returns, reply with the ONE-LINE summary only — e.g. "Top candidates for the ML Engineer JD: 2 very strong, 2 strong, 1 partial." Do NOT repeat the candidates, their blocks, or any JSON: the candidate cards are rendered for the recruiter automatically.
4. If the tool reports an error (e.g. unknown JD), say what went wrong in one line.
5. Handle follow-ups naturally ("show the next 5", "why is X ranked below Y", "compare A and B") by calling the tool again when needed.

Keep replies concise.`;
    const pruned = pruneMessages({
      messages: await convertToModelMessages(this.messages),
      toolCalls: "before-last-2-messages",
      reasoning: "before-last-message"
    });
    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      system,
      messages: pruned,
      tools: {
        shortlistCandidates: tool({
          description:
            "Retrieve the most relevant candidate profiles from the talent pool for a job description, ranked by embedding similarity. Pass jdTitle for one of the precomputed JDs, or query with free-text requirements. The model then re-ranks and classifies the returned candidates.",
          inputSchema: z
            .object({
              jdTitle: z
                .string()
                .optional()
                .describe(
                  "Precomputed JD title: ML Engineer, Software Engineer, or Senior Software Engineer. Omit when the user supplied their own requirements."
                ),
              query: z
                .string()
                .optional()
                .describe(
                  "Free-text role requirements when no precomputed JD is used."
                ),
              limit: z
                .number()
                .min(1)
                .max(15)
                .optional()
                .default(5)
                .describe("How many candidates to retrieve (default 5).")
            })
            .catch(() => ({
              jdTitle: undefined,
              query: undefined,
              limit: 5
            })),
          execute: async ({ jdTitle, query, limit }, options) => {
            try {
              const k = Math.min(limit ?? 5, 15);
              let jd: JD | null = null;
              let effectiveQuery: string = (query ?? "").trim();
              let effectiveTitle: string | undefined = jdTitle;
              // fp8-fast sometimes drops the arg string on tool calls. If the
              // model sent neither, fall back to the last user message: resolve
              // it as a JD title when it names one ("Shortlist the ML Engineer
              // JD."), else use it verbatim as the query.
              if (!effectiveTitle && !effectiveQuery) {
                const last = lastUserMessageText(
                  ((options as { messages?: unknown[] } | undefined)
                    ?.messages ?? []) as Array<{
                    role?: string;
                    content?: unknown;
                  }>
                );
                const matched = [...JD_TITLES]
                  .sort((a, b) => b.length - a.length)
                  .find((t) => last.toLowerCase().includes(t.toLowerCase()));
                effectiveTitle = matched;
                if (!matched) effectiveQuery = last.trim();
              }
              if (effectiveTitle) {
                jd = await getJD(this.env, jdSlug(effectiveTitle));
                if (!jd) {
                  return {
                    error: `Unknown JD "${effectiveTitle}". Call getJDs to list the available precomputed JDs.`
                  };
                }
                effectiveQuery = jdText(jd);
              }
              if (!effectiveQuery) {
                return { error: "Provide either a jdTitle or a query." };
              }

              // Loop breaker (mechanical, not prose): an identical repeat call
              // returns nothing new, so there is nothing for the model to loop
              // on or to parrot back. The custom stopWhen below also halts the
              // step loop the moment a shortlistCandidates call repeats a prior
              // identical one. Flip the jdTitle to a resolved title (not the
              // raw input) so "ML Engineer" vs the button text hash the same.
              const sig = `${effectiveTitle ? jdSlug(effectiveTitle) : ""}|${effectiveQuery.slice(0, 200)}|${k}`;
              if (this.shortlistSig === sig) return null;
              this.shortlistSig = sig;
              const candidates: CandidateHit[] = await search(
                this.env,
                effectiveQuery,
                k
              );
              console.error(
                `[search] query="${effectiveQuery.slice(0, 60)}"|jd=${effectiveTitle ?? "-"}|hits=${candidates.length}`
              );
              // Llama now classifies the evidence into a strict schema-valid
              // shortlist; the model can't drift out of the block format.
              const shortlist = await classifyShortlist(
                this.env,
                jd,
                effectiveQuery,
                candidates
              );
              return {
                jd: jd
                  ? {
                      slug: jd.slug,
                      title: jd.title,
                      summary: jd.summary,
                      must_have: jd.must_have,
                      nice_to_have: jd.nice_to_have
                    }
                  : null,
                query: effectiveQuery.slice(0, 300),
                shortlist
              };
            } catch (error) {
              console.error("shortlistCandidates failed:", error);
              return {
                error: error instanceof Error ? error.message : String(error)
              };
            }
          }
        }),

        getJDs: tool({
          description:
            "List the precomputed job descriptions available in the pool (used to resolve a user reference to a known role).",
          inputSchema: z.object({}),
          execute: async () => {
            const jds = await listJDs(this.env);
            return jds.length > 0
              ? jds.map((jd) => ({ slug: jd.slug, title: jd.title }))
              : "No JDs seeded yet — run the seed step (POST /__seed).";
          }
        })
      },
      stopWhen: [
        // Deterministic loop-killer: if the model calls shortlistCandidates
        // with the SAME arguments twice across steps, that's a repeat loop —
        // stop before step N+1 so it can't spool the same answer 6 times.
        ({
          steps
        }: {
          steps: Array<{
            toolCalls?: Array<{ toolName?: string; input?: unknown }>;
          }>;
        }) => {
          const sigs = new Set<string>();
          for (const step of steps) {
            for (const tc of step.toolCalls ?? []) {
              if (tc.toolName !== "shortlistCandidates") continue;
              const key = JSON.stringify(tc.input);
              if (sigs.has(key)) return true;
              sigs.add(key);
            }
          }
          return false;
        },
        stepCountIs(6)
      ],
      abortSignal: options?.abortSignal,
      onError: ({ error }) => {
        console.error("Chat stream error:", error);
      },
      // Option 2 safeguard: if the model emits a tool-call argument string
      // that is not valid JSON at all, the parse throws before `execute` and
      // the SDK loops the call forever (masked as "An error occurred.").
      // Salvage any JSON we can and fall back to {} — the schema `.catch()`
      // then guarantees a valid object, so the tool runs and returns a real
      // result (or a clean "provide a query" error) instead of looping.
      experimental_repairToolCall: async ({ toolCall }) => ({
        ...toolCall,
        input: JSON.stringify(
          (() => {
            try {
              const parsed = JSON.parse(toolCall.input.trim() || "{}");
              return parsed && typeof parsed === "object" ? parsed : {};
            } catch {
              return {};
            }
          })()
        )
      })
    });

    // onError passes the REAL error text through to the client tool card
    // instead of the SDK default "An error occurred." — needed to debug
    // tool-call validation failures without a round trip.
    return result.toUIMessageStreamResponse({
      onError: (error) =>
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/__seed" && request.method === "POST") {
      if (request.headers.get("x-seed-token") !== env.SEED_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      const result = await seed(env);
      return Response.json(result);
    }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
