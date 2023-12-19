import { parseComplexResponse } from './parse-complex-response';
import { readDataStream } from './read-data-stream';
import { JSONValue } from './types';
import { COMPLEX_HEADER, createChunkDecoder } from './utils';

export async function callCompletionApi({
  api,
  prompt,
  credentials,
  headers,
  body,
  setCompletion,
  abortController,
  onResponse,
  onFinish,
  onData,
}: {
  api: string;
  prompt: string;
  credentials?: RequestCredentials;
  headers?: HeadersInit;
  body: Record<string, any>;
  setCompletion: (completion: string) => void;
  abortController: () => AbortController | null;
  onResponse?: (response: Response) => void | Promise<void>;
  onFinish?: (prompt: string, completion: string) => void;
  onData?: (data: JSONValue[]) => void;
}) {
  const res = await fetch(api, {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      ...body,
    }),
    credentials,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    signal: abortController?.()?.signal,
  }).catch(err => {
    throw err;
  });

  if (onResponse) {
    try {
      await onResponse(res);
    } catch (err) {
      throw err;
    }
  }

  if (!res.ok) {
    throw new Error((await res.text()) || 'Failed to fetch the chat response.');
  }

  if (!res.body) {
    throw new Error('The response body is empty.');
  }

  let result = '';
  const reader = res.body.getReader();

  const isComplexMode = res.headers.get(COMPLEX_HEADER) === 'true';

  if (isComplexMode) {
    for await (const { type, value } of readDataStream(reader, {
      isAborted: () => abortController === null,
    })) {
      switch (type) {
        case 'text': {
          result += value;
          setCompletion(result);
          break;
        }
        case 'data': {
          onData?.(value);
          break;
        }
      }
    }
  } else {
    const createdAt = new Date();
    const decode = createChunkDecoder(false);

    // TODO-STREAMDATA: Remove this once Stream Data is not experimental
    let streamedResponse = '';

    // TODO-STREAMDATA: Remove this once Stream Data is not experimental
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // Update the chat state with the new message tokens.
      streamedResponse += decode(value);

      result += streamedResponse;
      setCompletion(result);

      // The request has been aborted, stop reading the stream.
      if (abortController?.() === null) {
        reader.cancel();
        break;
      }
    }

    if (onFinish) {
      onFinish(prompt, result);
    }

    return result;
  }
}
