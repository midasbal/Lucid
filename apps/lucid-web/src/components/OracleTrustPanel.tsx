import { useEffect, useState } from "react";
import {
  fetchOracleQuestion,
  fetchCaliberRating,
  exchangeName,
  formatOracleValue,
  type OracleQuestion,
  type CaliberResult,
} from "../lib/oracle";

interface TrustState {
  loading: boolean;
  question: OracleQuestion | null;
  caliber: CaliberResult | null;
  error: string | null;
  /** Set when framing is "pending" and the fetched question looks like it
   *  does not actually belong to this market (see the mismatch guard
   *  below). The panel refuses to render mismatched data rather than show
   *  something misleading. */
  mismatch: boolean;
}

const IDLE: TrustState = { loading: true, question: null, caliber: null, error: null, mismatch: false };

function ratingColor(rating: string): string {
  if (rating.startsWith("AAA") || rating.startsWith("AA")) return "yes";
  if (rating.startsWith("A") || rating.startsWith("BBB")) return "warn";
  return "no";
}

/**
 * The oracle's own resolution/trust detail for one market's oracleQuestionId,
 * joined per TRUST-PANEL.md: the six (or however many) source answers, the
 * agreement threshold, the final posted answer, and the caliber quality
 * rating. Two framings:
 *
 * - "resolved": oracleQuestionId came from MarketResolutionEvent, confirmed
 *   accurate (TRUST-PANEL.md's join finding). Framed as how this market
 *   resolved.
 * - "pending": oracleQuestionId came from a still-Trading market's own row.
 *   That field was found live to carry a stale value at least once
 *   (TRUST-PANEL.md), so this framing applies a mismatch guard: if the
 *   fetched question already reads "Resolved" (a genuinely future question
 *   cannot be), the panel refuses to render it as this market's setup.
 */
export function OracleTrustPanel({
  oracleQuestionId,
  framing,
  marketAsset,
}: {
  oracleQuestionId: string | null;
  framing: "resolved" | "pending";
  marketAsset: string;
}) {
  const [state, setState] = useState<TrustState>(IDLE);

  useEffect(() => {
    if (!oracleQuestionId) {
      setState({ ...IDLE, loading: false });
      return;
    }
    let cancelled = false;
    setState({ ...IDLE, loading: true });

    (async () => {
      try {
        const question = await fetchOracleQuestion(oracleQuestionId);
        if (cancelled) return;

        const mismatch = framing === "pending" && question !== null && question.status === "Resolved";

        const caliber = question && !mismatch ? await fetchCaliberRating(oracleQuestionId) : null;
        if (cancelled) return;

        setState({ loading: false, question, caliber, error: null, mismatch });
      } catch (e) {
        if (!cancelled) setState({ loading: false, question: null, caliber: null, error: (e as Error).message, mismatch: false });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [oracleQuestionId, framing]);

  const title = framing === "resolved" ? "How this market resolved" : "How this market will resolve";

  if (!oracleQuestionId) {
    return (
      <div className="panel" data-testid="trust-panel">
        <h2 className="section-title">{title}</h2>
        <div className="empty-state">
          {framing === "resolved" ? "no oracle question found for this market" : "resolution setup not available yet for this market"}
        </div>
      </div>
    );
  }

  if (state.loading) {
    return (
      <div className="panel" data-testid="trust-panel">
        <h2 className="section-title">{title}</h2>
        <div className="empty-state">loading oracle detail…</div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="panel" data-testid="trust-panel">
        <h2 className="section-title">{title}</h2>
        <div className="gate-banner error" data-testid="trust-error">
          {state.error}
        </div>
      </div>
    );
  }

  if (state.mismatch) {
    return (
      <div className="panel" data-testid="trust-panel">
        <h2 className="section-title">{title}</h2>
        <div className="empty-state">resolution setup not available yet for this market</div>
      </div>
    );
  }

  if (!state.question) {
    return (
      <div className="panel" data-testid="trust-panel">
        <h2 className="section-title">{title}</h2>
        <div className="empty-state" data-testid="trust-aged-out">
          this question has aged out of the oracle's own retention, no source detail available
        </div>
      </div>
    );
  }

  const q = state.question;
  const successCount = q.sourceAnswers.filter((s) => s.success).length;
  const totalCount = q.sourceAnswers.length;
  const finalAnswer = q.answers[0];

  return (
    <div className="panel" data-testid="trust-panel" data-oracle-question-id={q.id}>
      <h2 className="section-title">{title}</h2>

      {q.displayName && <p className="trust-question">{q.displayName}</p>}

      <div className="trust-summary-row">
        <div className="stat">
          <div className="stat-label">agreement</div>
          <div className="stat-value" data-testid="trust-agreement">
            {successCount} of {totalCount} sources answered{q.minAgreement !== null ? `, ${q.minAgreement} required` : ""}
          </div>
        </div>
        {finalAnswer && (
          <div className="stat">
            <div className="stat-label">posted answer</div>
            <div className="stat-value fair-value" data-testid="trust-final-answer">
              {formatOracleValue(finalAnswer.numericValue, q.numericDecimals)}
            </div>
          </div>
        )}
      </div>

      <div className="trust-source-list" data-testid="trust-source-list">
        {q.sourceAnswers
          .slice()
          .sort((a, b) => a.sourceIdx - b.sourceIdx)
          .map((s) => {
            const name = exchangeName(s.authorityId);
            return (
              <div
                key={s.sourceIdx}
                className="trust-source-row"
                data-testid="trust-source-row"
                data-source={name}
                data-success={s.success}
                data-value={s.numericValue ?? ""}
              >
                <span className={`trust-source-dot ${s.success ? "pass" : "fail"}`} />
                <span className="trust-source-name">{name}</span>
                <span className="trust-source-value">{formatOracleValue(s.numericValue, q.numericDecimals)}</span>
                <span className={`trust-source-status ${s.success ? "pass" : "fail"}`}>{s.success ? "reported" : "failed"}</span>
              </div>
            );
          })}
      </div>

      {state.caliber === null || state.caliber.kind === "unavailable" ? (
        <p className="disclaimer" data-testid="trust-caliber-unavailable">
          quality rating unavailable right now
        </p>
      ) : state.caliber.kind === "unrated" ? (
        <p className="disclaimer" data-testid="trust-caliber-unrated">
          not yet rated by the oracle's own quality service
        </p>
      ) : (
        <div className="trust-caliber" data-testid="trust-caliber">
          <div className="trust-caliber-head">
            <span className={`trust-caliber-badge ${ratingColor(state.caliber.rating.rating)}`} data-testid="trust-caliber-rating">
              {state.caliber.rating.rating}
            </span>
            <span className="trust-caliber-score" data-testid="trust-caliber-score">
              {state.caliber.rating.score}/100
            </span>
            <span className="trust-caliber-definition">{state.caliber.rating.definition}</span>
          </div>
          <ul className="trust-criteria-list">
            {state.caliber.rating.criteria.map((c) => (
              <li key={c.key} className="trust-criterion" data-testid="trust-criterion" data-key={c.key} data-status={c.status}>
                <span className={`trust-criterion-dot ${c.status === "pass" ? "pass" : "fail"}`} />
                <span className="trust-criterion-name">{c.name}</span>
                <span className="trust-criterion-summary">{c.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="disclaimer">
        {marketAsset} resolution detail from the oracle's own service, independent of this app, joined by oracleQuestionId {q.id}.
      </p>
    </div>
  );
}
