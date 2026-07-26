// Shared scaffolding for CippService tests: every suite mocks `fetch` and then
// asserts on the request CIPP would actually have received.

/** A successful CIPP response carrying `payload` as its JSON body. */
export function jsonResponse(payload: unknown): Response {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

/** The parsed JSON body of the first request sent to `endpoint`. */
export function bodyOf(
  fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>,
  endpoint: string
): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([url]) => url.includes(endpoint));
  if (!call) throw new Error(`no request was sent to ${endpoint}`);
  return JSON.parse(call[1].body as string);
}

/** Whether any request was sent to `endpoint`. */
export function calledEndpoint(
  fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>,
  endpoint: string
): boolean {
  return fetchMock.mock.calls.some(([url]) => url.includes(endpoint));
}
