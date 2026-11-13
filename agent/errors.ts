/**
 * A failure the command line should report in its own voice rather than as a stack trace.
 *
 * `exitCode` follows Warren's convention: 1 when the tool worked and the answer is bad news
 * (nothing matched), 2 when the invocation or the world around it was wrong (no key, no
 * server, no such file).
 */
export class AgentError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode: number) {
    super(message)
    this.name = 'AgentError'
    this.exitCode = exitCode
  }
}

export const usage = (message: string): AgentError => new AgentError(message, 2)
export const problem = (message: string): AgentError => new AgentError(message, 1)
