/** Process-wide internal token guarding the /_llm proxy endpoint. */
let token: string | null = null;

export function setInternalToken(t: string): void {
  token = t;
}

export function getInternalToken(): string | null {
  return token;
}
