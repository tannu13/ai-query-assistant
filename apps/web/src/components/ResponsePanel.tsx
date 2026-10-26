import type { QueryResponse } from '@repo/shared';

export interface ResponsePanelProps {
  response: QueryResponse;
}

export function ResponsePanel({ response }: ResponsePanelProps) {
  return (
    <section className="card" aria-labelledby="answer-heading">
      <div className="card__header">
        <h2 id="answer-heading">Answer</h2>
        <span className="badge" title="The model that actually answered">
          {response.model}
        </span>
      </div>

      {response.truncated && (
        /**
         * A third outcome, neither success nor failure: the model stopped at
         * its token limit, so the text below is real but incomplete. Saying
         * so is the difference between a partial answer and a wrong one.
         */
        <p className="notice notice--warning" role="status">
          This answer was cut short at the model&rsquo;s token limit, so it is
          incomplete.
        </p>
      )}

      {/*
        Rendered as TEXT. There is no `dangerouslySetInnerHTML` anywhere in
        this app, and that is the single most important line in this file:
        model output is untrusted data. A model can be talked into emitting
        `<img src=x onerror=…>`, and treating its output as markup turns
        prompt injection into stored XSS. `white-space: pre-wrap` preserves
        the newlines that make the answer readable without interpreting
        anything.

        `aria-live="polite"` so the answer is announced when it arrives
        without interrupting whatever the user is doing.
      */}
      <div className="answer" aria-live="polite">
        {response.answer}
      </div>

      <dl className="meta">
        <div>
          <dt>Finish reason</dt>
          <dd>{response.finishReason ?? '—'}</dd>
        </div>
        {response.usage && (
          <>
            <div>
              <dt>Prompt tokens</dt>
              <dd>{response.usage.promptTokens}</dd>
            </div>
            <div>
              <dt>Response tokens</dt>
              <dd>{response.usage.responseTokens}</dd>
            </div>
          </>
        )}
        <div>
          <dt>Request id</dt>
          <dd>
            <code>{response.requestId}</code>
          </dd>
        </div>
      </dl>
    </section>
  );
}

export default ResponsePanel;
