import { PROMPT_MAX_CHARS } from '@repo/shared';
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

export interface QueryFormProps {
  pending: boolean;
  onSubmit(prompt: string): void;
  onCancel(): void;
}

export function QueryForm({ pending, onSubmit, onCancel }: QueryFormProps) {
  const [prompt, setPrompt] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);

  const trimmed = prompt.trim();
  /**
   * The cap comes from the shared contract, which is also where the server
   * reads its default. So the client-side limit cannot drift into permitting
   * a prompt the server will reject — the usual way this goes wrong is two
   * hardcoded numbers that agree until one is changed.
   *
   * It remains a convenience, never a control: the server's
   * LLM_MAX_PROMPT_CHARS is authoritative and enforced regardless.
   */
  const tooLong = prompt.length > PROMPT_MAX_CHARS;
  const empty = trimmed === '';
  const canSubmit = !pending && !tooLong && !empty;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (canSubmit) onSubmit(trimmed);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter submits; plain Enter stays a newline, because the field
    // is a textarea and multi-line prompts are the normal case.
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (canSubmit) onSubmit(trimmed);
    }
  }

  const remaining = PROMPT_MAX_CHARS - prompt.length;

  return (
    <section className="card" aria-labelledby="query-heading">
      <h2 id="query-heading">Ask a question</h2>

      <form onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="prompt">Your question</label>
          <textarea
            id="prompt"
            name="prompt"
            ref={textarea}
            rows={5}
            value={prompt}
            placeholder="Why is the sky blue?"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={pending}
            aria-describedby="prompt-counter"
            aria-invalid={tooLong}
          />
          <p
            id="prompt-counter"
            className={tooLong ? 'counter counter--over' : 'counter'}
            // Announced only when it matters, so a screen reader is not read
            // a running character count on every keystroke.
            aria-live={tooLong ? 'polite' : 'off'}
          >
            {tooLong
              ? `${-remaining} character${remaining === -1 ? '' : 's'} over the ${PROMPT_MAX_CHARS} limit`
              : `${remaining} characters remaining`}
          </p>
        </div>

        <div className="actions">
          <button type="submit" className="button" disabled={!canSubmit}>
            {pending ? 'Asking…' : 'Ask'}
          </button>
          {pending && (
            <button
              type="button"
              className="button button--ghost"
              onClick={onCancel}
            >
              Cancel
            </button>
          )}
          <span className="hint">
            <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> to submit
          </span>
        </div>
      </form>
    </section>
  );
}

export default QueryForm;
