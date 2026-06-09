export async function readSseStream<TEvent>(
  response: Response,
  onEvent: (event: TEvent) => void
) {
  if (!response.body) throw new Error("Response body is empty");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      const line = chunk
        .split("\n")
        .find((part) => part.startsWith("data:"))
        ?.replace(/^data:\s*/, "");
      if (!line || line === "[DONE]") continue;
      onEvent(JSON.parse(line) as TEvent);
    }
  }
}
