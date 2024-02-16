import { useCallback, useEffect, useId, useRef, useState } from 'react';
import useSWR, { KeyedMutator } from 'swr';
import { callCompletionApi } from '../shared/call-completion-api-server';
import {
  JSONValue,
  RequestOptions,
  UseCompletionOptions,
} from '../shared/types';
import {
  ReactResponseRow,
  experimental_StreamingReactResponse,
} from '../streams/streaming-react-response';

export type UseCompletionHelpers = {
  /** The current completion result */
  completion: string;
  /**
   * Send a new prompt to the API endpoint and update the completion state.
   */
  complete: (
    prompt: string,
    options?: RequestOptions,
  ) => Promise<string | null | undefined>;
  /** The error object of the API request */
  error: undefined | Error;
  /**
   * Abort the current API request but keep the generated tokens.
   */
  stop: () => void;
  /**
   * Update the `completion` state locally.
   */
  setCompletion: (completion: string) => void;
  /** The current value of the input */
  input: string;
  /** setState-powered method to update the input value */
  setInput: React.Dispatch<React.SetStateAction<string>>;
  /**
   * An input/textarea-ready onChange handler to control the value of the input
   * @example
   * ```jsx
   * <input onChange={handleInputChange} value={input} />
   * ```
   */
  handleInputChange: (
    e:
      | React.ChangeEvent<HTMLInputElement>
      | React.ChangeEvent<HTMLTextAreaElement>,
  ) => void;
  /**
   * Form submission handler to automatically reset input and append a user message
   * @example
   * ```jsx
   * <form onSubmit={handleSubmit}>
   *  <input onChange={handleInputChange} value={input} />
   * </form>
   * ```
   */
  handleSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  /** Whether the API request is in progress */
  isLoading: boolean;
  /** Additional data added on the server via StreamData */
  data?: JSONValue[] | undefined;
};

export type StreamingReactResponseAction = (payload: {
  prompt: string;
  body?: Record<string, any>;
}) => Promise<experimental_StreamingReactResponse>;

const getStreamedResponse = async (
  api: string | StreamingReactResponseAction,
  prompt: string,
  options: RequestOptions | undefined,
  mutate: KeyedMutator<string>,
  mutateStreamData: KeyedMutator<JSONValue[] | undefined>,
  existingData: JSONValue[] | undefined,
  extraMetadataRef: React.MutableRefObject<any>,
  abortControllerRef: React.MutableRefObject<AbortController | null>,
  onFinish?: (prompt: string, completion: string) => void,
  onResponse?: (response: Response) => void | Promise<void>,
) => {
  if (typeof api !== 'string') {
    // In this case, we are handling a Server Action. No complex mode handling needed.
    let completion = '';

    async function readRow(promise: Promise<ReactResponseRow>) {
      const { content, ui, next, ...rest } = await promise;

      // Server actions requires us to friendly handle errors
      if (rest.error) throw new Error(rest.error);

      // TODO: Handle function calls.
      completion = content;

      mutate(completion, false);

      if (next) {
        await readRow(next);
      }
    }

    const promise = api({
      prompt,
      ...extraMetadataRef.current.body,
      ...options?.body,
    }) as Promise<ReactResponseRow>;
    await readRow(promise);

    if (onFinish) {
      onFinish(prompt, completion);
    }

    return completion;
  }

  return await callCompletionApi({
    api,
    prompt,
    credentials: extraMetadataRef.current.credentials,
    headers: { ...extraMetadataRef.current.headers, ...options?.headers },
    body: {
      ...extraMetadataRef.current.body,
      ...options?.body,
    },
    setCompletion: completion => mutate(completion, false),
    abortController: () => abortControllerRef.current,
    onResponse,
    onFinish,
    onData: data => {
      mutateStreamData([...(existingData || []), ...(data || [])], false);
    },
  });
};

type UseCompletionOptionsServer = Omit<UseCompletionOptions, 'api'> & {
  api?: string | StreamingReactResponseAction;
  key?: string;
};

export function useCompletion({
  api = '/api/completion',
  id,
  initialCompletion = '',
  initialInput = '',
  credentials,
  headers,
  body,
  onResponse,
  onFinish,
  onError,
}: UseCompletionOptionsServer = {}): UseCompletionHelpers {
  // Generate an unique id for the completion if not provided.
  const hookId = useId();
  const completionId = id || hookId;

  // Store the completion state in SWR, using the completionId as the key to share states.
  const { data, mutate } = useSWR<string>([api, completionId], null, {
    fallbackData: initialCompletion,
  });

  const { data: isLoading = false, mutate: mutateLoading } = useSWR<boolean>(
    [completionId, 'loading'],
    null,
  );

  const { data: streamData, mutate: mutateStreamData } = useSWR<
    JSONValue[] | undefined
  >([completionId, 'streamData'], null);

  const { data: error = undefined, mutate: setError } = useSWR<
    undefined | Error
  >([completionId, 'error'], null);

  const completion = data!;

  // Abort controller to cancel the current API call.
  const abortControllerRef = useRef<AbortController | null>(null);

  const extraMetadataRef = useRef({
    credentials,
    headers,
    body,
  });
  useEffect(() => {
    extraMetadataRef.current = {
      credentials,
      headers,
      body,
    };
  }, [credentials, headers, body]);

  const triggerRequest = useCallback(
    async (prompt: string, options?: RequestOptions) => {
      try {
        mutateLoading(true);
        setError(undefined);

        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        await getStreamedResponse(
          api,
          prompt,
          options,
          mutate,
          mutateStreamData,
          streamData!,
          extraMetadataRef,
          abortControllerRef,
          onFinish,
          onResponse,
        );

        abortControllerRef.current = null;
      } catch (err) {
        // Ignore abort errors as they are expected.
        if ((err as any).name === 'AbortError') {
          abortControllerRef.current = null;
          return null;
        }

        if (onError && err instanceof Error) {
          onError(err);
        }

        setError(err as Error);
      } finally {
        mutateLoading(false);
      }
    },
    [
      mutate,
      mutateLoading,
      api,
      extraMetadataRef,
      abortControllerRef,
      onResponse,
      onFinish,
      onError,
      setError,
      streamData,
      mutateStreamData,
    ],
  );

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const setCompletion = useCallback(
    (completion: string) => {
      mutate(completion, false);
    },
    [mutate],
  );

  const complete = useCallback<UseCompletionHelpers['complete']>(
    async (prompt, options) => {
      return triggerRequest(prompt, options);
    },
    [triggerRequest],
  );

  const [input, setInput] = useState(initialInput);

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!input) return;
      return complete(input);
    },
    [input, complete],
  );

  const handleInputChange = (e: any) => {
    setInput(e.target.value);
  };

  return {
    completion,
    complete,
    error,
    setCompletion,
    stop,
    input,
    setInput,
    handleInputChange,
    handleSubmit,
    isLoading,
    data: streamData,
  };
}
