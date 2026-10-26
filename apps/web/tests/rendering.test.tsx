import type { QueryResponse } from '@repo/shared';
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import ErrorNotice from '../src/components/ErrorNotice';
import ResponsePanel from '../src/components/ResponsePanel';
import { ApiError } from '../src/lib/api';

/**
 * The payload a model can be talked into emitting. If model output were ever
 * rendered as markup, this is what would execute.
 */
const XSS_PAYLOAD = '<img src=x onerror=alert(1)>';

function answer(overrides: Partial<QueryResponse> = {}): QueryResponse {
  return {
    answer: 'Rayleigh scattering.',
    model: 'fake-model-1',
    finishReason: 'STOP',
    truncated: false,
    requestId: 'req-123',
    ...overrides,
  };
}

describe('model output is treated as untrusted data', () => {
  /**
   * The Phase 6 gate verified this in a real browser — the payload rendered
   * as visible text, no `<img>` was created, and the trapped `alert()` never
   * fired. This test exists so the property survives a refactor without
   * anyone having to remember to drive a browser again.
   *
   * React escapes by default, so this passes today for free. That is exactly
   * why it is worth asserting: the regression is a single
   * `dangerouslySetInnerHTML` added by someone wanting to render markdown,
   * and nothing else in the suite would notice.
   */
  it('escapes an HTML payload in the answer rather than emitting markup', () => {
    const html = renderToStaticMarkup(
      <ResponsePanel response={answer({ answer: XSS_PAYLOAD })} />,
    );

    // The payload survives as escaped TEXT, with its angle brackets encoded.
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // And no element is created. Note that asserting the absence of the
    // substring `onerror=` would be wrong: it appears legitimately inside the
    // escaped text. What must be absent is the tag.
    expect(html).not.toContain('<img');
  });

  it('escapes a payload arriving through the model name', () => {
    // Every field from the server is untrusted, not just the answer body.
    const html = renderToStaticMarkup(
      <ResponsePanel response={answer({ model: XSS_PAYLOAD })} />,
    );

    expect(html).not.toContain('<img');
  });

  it('escapes a payload arriving through an error message', () => {
    const html = renderToStaticMarkup(
      <ErrorNotice
        error={new ApiError('LLM_UNAVAILABLE', XSS_PAYLOAD, { requestId: 'r' })}
      />,
    );

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('has no markup sink anywhere in the app', async () => {
    // A structural check to go with the behavioural ones: the regression this
    // guards against is someone introducing the sink, so look for the sink.
    const files = new Bun.Glob('src/**/*.{ts,tsx}');
    const offenders: string[] = [];
    for await (const file of files.scan('.')) {
      const source = await Bun.file(file).text();
      // Comments are stripped first. Without this the check flags
      // ResponsePanel.tsx, whose comment explains why the sink is absent —
      // a scanner that cannot tell code from prose would make the only
      // honest way to pass it to stop documenting the decision.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML/.test(code)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('ResponsePanel', () => {
  it('warns when the answer was truncated', () => {
    const html = renderToStaticMarkup(
      <ResponsePanel response={answer({ truncated: true })} />,
    );

    // A truncated answer is neither a success nor a failure, and saying so is
    // the difference between a partial answer and a wrong one.
    expect(html).toContain('cut short');
  });

  it('says nothing about truncation when the answer is complete', () => {
    expect(renderToStaticMarkup(<ResponsePanel response={answer()} />)).not.toContain(
      'cut short',
    );
  });

  it('reports the model and the request id', () => {
    const html = renderToStaticMarkup(<ResponsePanel response={answer()} />);

    expect(html).toContain('fake-model-1');
    expect(html).toContain('req-123');
  });
});

describe('ErrorNotice', () => {
  it('offers retry only for codes the shared contract calls retryable', () => {
    const retryable = renderToStaticMarkup(
      <ErrorNotice
        error={new ApiError('LLM_TIMEOUT', 'Timed out.')}
        onRetry={() => {}}
      />,
    );
    const notRetryable = renderToStaticMarkup(
      <ErrorNotice
        error={new ApiError('LLM_CONTENT_BLOCKED', 'Declined.')}
        onRetry={() => {}}
      />,
    );

    // A retry button on a prompt that will fail identically every time
    // teaches the user to distrust the button.
    expect(retryable).toContain('Retry');
    expect(notRetryable).not.toContain('Retry');
  });

  it('gives cause-specific guidance rather than one generic message', () => {
    const expired = renderToStaticMarkup(
      <ErrorNotice error={new ApiError('AUTH_EXPIRED_TOKEN', 'Expired.')} />,
    );
    const blocked = renderToStaticMarkup(
      <ErrorNotice error={new ApiError('LLM_CONTENT_BLOCKED', 'Declined.')} />,
    );

    expect(expired).toContain('Sign in again');
    expect(blocked).toContain('Rephrasing');
    expect(expired).not.toBe(blocked);
  });

  it('surfaces the request id so a user can quote it', () => {
    const html = renderToStaticMarkup(
      <ErrorNotice
        error={new ApiError('INTERNAL_ERROR', 'Broke.', { requestId: 'abc-123' })}
      />,
    );

    expect(html).toContain('abc-123');
  });

  it('lists field-level validation details', () => {
    const html = renderToStaticMarkup(
      <ErrorNotice
        error={new ApiError('VALIDATION_FAILED', 'Invalid.', {
          details: [{ path: 'prompt', message: 'Enter a question' }],
        })}
      />,
    );

    expect(html).toContain('prompt');
    expect(html).toContain('Enter a question');
  });
});
