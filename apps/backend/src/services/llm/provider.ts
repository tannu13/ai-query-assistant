/**
 * The seam between this application and whichever model actually answers.
 *
 * The brief says "an LLM API of your choice", which invites "how would you
 * swap it?". This interface is the answer, and it is load-bearing rather than
 * speculative: `fake.ts` implements it, which is what makes the failure paths
 * testable without a network or a token budget.
 *
 * Note what the domain type does NOT expose: no SDK response object, no
 * provider enums, no HTTP status. An adapter that leaked any of those would
 * put vendor knowledge in the routes, and the next provider would be a
 * rewrite rather than a file.
 */

export interface LlmCompletion {
  /** Guaranteed non-empty. An empty answer is an error, not a completion. */
  text: string;
  /** The model that actually answered, which may be a resolved alias. */
  model: string;
  /** The provider's stop reason, normalised to a string, when it reports one. */
  finishReason: string | null;
  /**
   * True when generation stopped at the token limit. The text is usable but
   * incomplete — a third outcome that is neither success nor failure, and
   * which the UI must be able to say out loud.
   */
  truncated: boolean;
  usage?: {
    promptTokens: number;
    responseTokens: number;
  };
}

export interface LlmCompleteInput {
  prompt: string;
  /**
   * Caller-side cancellation — a disconnected browser, or a superseded
   * request. The adapter composes this with its own deadline; the deadline
   * itself is NOT the caller's business, which is why it is configured on the
   * adapter and absent from this interface.
   */
  signal?: AbortSignal;
}

export interface LlmProvider {
  /** Identifies the implementation in logs and in the smoke script. */
  readonly name: string;
  complete(input: LlmCompleteInput): Promise<LlmCompletion>;
}
