// Direct reads against the oracle's own resolution-detail service, a
// separate system entirely from the markets indexer (DATA-RECON.md section
// 3): its own GraphQL at prd.oracle.somnia.host/v1/graphql, confirmed
// no-auth, plus a REST caliber endpoint at /api/caliber/{id}, also no-auth.
// Joined to a market via oracleQuestionId, confirmed live to equal
// MarketResolutionEvent.oracleQuestionId once a market resolves (see
// indexer.ts's fetchMarketResolution and TRUST-PANEL.md's join finding).
//
// Plain fetch, no SDK involved: this service is not part of
// @somnia-chain/markets-sdk at all.

const ORACLE_GRAPHQL_URL = "https://prd.oracle.somnia.host/v1/graphql";
const ORACLE_CALIBER_URL = (id: string) => `https://prd.oracle.somnia.host/api/caliber/${id}`;

export interface OracleAnswer {
  outcomeIdx: number;
  label: string;
  numericValue: string | null;
  voided: boolean;
}

export interface OracleSourceAnswer {
  sourceIdx: number;
  success: boolean;
  numericValue: string | null;
  recordedAtTimestamp: string | null;
  /** The exchange domain behind this answer, e.g. "http:api.mexc.com". Read
   *  from the SourceAnswer's own source relation, not inferred from
   *  sourceIdx: sourceIdx order does NOT match a fixed exchange order
   *  (confirmed live, see TRUST-PANEL.md), sourceIdx 5 was MEXC on one
   *  question and a different exchange's position varies question to
   *  question, so the display name has to come from this field. */
  authorityId: string | null;
}

export interface OracleQuestion {
  id: string;
  displayName: string | null;
  status: string | null;
  resolutionTime: string | null;
  resolvedAtTimestamp: string | null;
  /** How many of the sources below must agree for the question to resolve. */
  minAgreement: number | null;
  /** Decimal scale for numericValue on this question. Can be null on an
   *  older question (confirmed live on question id "1"); when null, the raw
   *  integer is shown rather than guessing a scale. */
  numericDecimals: number | null;
  answers: OracleAnswer[];
  sourceAnswers: OracleSourceAnswer[];
}

const QUESTION_QUERY = `
  query Q($id: String!) {
    Question_by_pk(id: $id) {
      id displayName status resolutionTime resolvedAtTimestamp
      minAgreement numericDecimals
      answers { outcomeIdx label numericValue voided }
      sourceAnswers {
        sourceIdx success numericValue recordedAtTimestamp
        source { authority_id }
      }
    }
  }
`;

/** The question behind one market's resolution: per-source raw answers,
 *  the agreement threshold, and the final posted answer. Returns null when
 *  the oracle service has no record for this id (a genuinely aged-out or
 *  unknown question, confirmed live to come back as a clean null rather
 *  than an error), the caller degrades to "resolution detail unavailable"
 *  rather than treating this as a failure. */
export async function fetchOracleQuestion(oracleQuestionId: string): Promise<OracleQuestion | null> {
  const res = await fetch(ORACLE_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUESTION_QUERY, variables: { id: oracleQuestionId } }),
  });
  if (!res.ok) throw new Error(`oracle request failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: {
      Question_by_pk: {
        id: string;
        displayName: string | null;
        status: string | null;
        resolutionTime: string | null;
        resolvedAtTimestamp: string | null;
        minAgreement: number | null;
        numericDecimals: number | null;
        answers: OracleAnswer[];
        sourceAnswers: Array<{
          sourceIdx: number;
          success: boolean;
          numericValue: string | null;
          recordedAtTimestamp: string | null;
          source: { authority_id: string } | null;
        }>;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) throw new Error(`oracle query failed: ${json.errors[0]!.message}`);
  const q = json.data?.Question_by_pk;
  if (!q) return null;
  return {
    id: q.id,
    displayName: q.displayName,
    status: q.status,
    resolutionTime: q.resolutionTime,
    resolvedAtTimestamp: q.resolvedAtTimestamp,
    minAgreement: q.minAgreement,
    numericDecimals: q.numericDecimals,
    answers: q.answers,
    sourceAnswers: q.sourceAnswers.map((s) => ({
      sourceIdx: s.sourceIdx,
      success: s.success,
      numericValue: s.numericValue,
      recordedAtTimestamp: s.recordedAtTimestamp,
      authorityId: s.source?.authority_id ?? null,
    })),
  };
}

/** authority_id is a scheme-prefixed host, e.g. "http:api.mexc.com".
 *  Mapped to the display name a human recognizes; falls back to the raw
 *  host for any exchange not in this list rather than hiding it. */
const EXCHANGE_NAMES: Array<[string, string]> = [
  ["binance", "Binance"],
  ["okx", "OKX"],
  ["bybit", "Bybit"],
  ["kucoin", "KuCoin"],
  ["gateio", "Gate.io"],
  ["mexc", "MEXC"],
];

export function exchangeName(authorityId: string | null): string {
  if (!authorityId) return "unknown source";
  const host = authorityId.replace(/^https?:/, "");
  for (const [needle, name] of EXCHANGE_NAMES) {
    if (host.includes(needle)) return name;
  }
  return host;
}

/** numericValue scaled by numericDecimals, or the raw integer string with a
 *  caveat when decimals are not provided (question id "1" confirmed live:
 *  numericDecimals is null on an old enough question). Never guesses a
 *  scale the way lucid-core's inferScale has to for the SDK's own
 *  OracleAnswer.numericValue (NOTES.md's Gate A); this service documents
 *  its own scale directly on the question. */
export function formatOracleValue(numericValue: string | null, numericDecimals: number | null): string {
  if (numericValue === null) return "-";
  if (numericDecimals === null) return `${numericValue} (raw, scale not provided)`;
  const n = Number(numericValue) / 10 ** numericDecimals;
  return n.toLocaleString(undefined, { maximumFractionDigits: Math.min(numericDecimals, 6) });
}

export interface CaliberCriterion {
  key: string;
  name: string;
  status: string;
  summary: string;
  score?: number;
  weight?: number;
}

export interface CaliberRating {
  id: string;
  rating: string;
  score: number;
  definition: string;
  criteria: CaliberCriterion[];
}

export type CaliberResult = { kind: "rated"; rating: CaliberRating } | { kind: "unrated" } | { kind: "unavailable" };

/** The caliber quality rating for one question: overall AAA-style score plus
 *  named, pass/fail criteria. Confirmed live to return {status:"unrated"}
 *  (still HTTP 200) for a question id the caliber service has no rating
 *  for, rather than a 404; that is treated as a distinct, non-error state
 *  here so the panel can show "not yet rated" instead of an error.
 *
 *  Confirmed live: unlike the GraphQL endpoint, this REST endpoint sends no
 *  Access-Control-Allow-Origin header on its OPTIONS preflight response, so
 *  a browser blocks the request outright with a CORS error, even though a
 *  server-to-server curl against the same URL succeeds cleanly. That
 *  surfaces to this code as fetch() rejecting, not as a bad status, so it
 *  is caught here and folded into the same "unavailable" state a real
 *  network failure would produce, rather than letting it propagate and
 *  take the rest of the panel down with it (the source list above comes
 *  from the GraphQL endpoint, which does carry proper CORS headers, and
 *  should render regardless of whether this call succeeds). */
export async function fetchCaliberRating(oracleQuestionId: string): Promise<CaliberResult> {
  let res: Response;
  try {
    res = await fetch(ORACLE_CALIBER_URL(oracleQuestionId));
  } catch {
    return { kind: "unavailable" };
  }
  if (!res.ok) return { kind: "unavailable" };
  const json = (await res.json()) as {
    status: string;
    result?: {
      id: string;
      rating: string;
      score: number;
      definition: string;
      criteria: Array<{ key: string; name: string; status: string; summary: string; score?: number; weight?: number }>;
    };
  };
  if (json.status !== "ok" || !json.result) return { kind: "unrated" };
  return {
    kind: "rated",
    rating: {
      id: json.result.id,
      rating: json.result.rating,
      score: json.result.score,
      definition: json.result.definition,
      criteria: json.result.criteria.map((c) => ({ key: c.key, name: c.name, status: c.status, summary: c.summary, score: c.score, weight: c.weight })),
    },
  };
}
