import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useEffectEvent } from "./useEffectEvent";

type JsonObject = Readonly<{ [key: string]: JsonValue }>;
type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | JsonObject;

type ReactSubscriptionCallback = (notifyReact: () => void) => () => void;

type SetLocalStorageCallback<TStorageValue extends JsonValue = JsonValue> = (
  payload:
    | TStorageValue
    | null
    | ((newValue: TStorageValue | null) => TStorageValue | null),
) => void;

type UseLocalStorageResult<TStorageValue extends JsonValue = JsonValue> =
  readonly [
    value: TStorageValue | null,
    setStorageValue: SetLocalStorageCallback<TStorageValue>,
  ];

type UseLocalStorageOptions<TStorageValue extends JsonValue = JsonValue> =
  Readonly<{
    key: string;
    fallbackValue?: TStorageValue;
    onError?: (error: Error) => void;

    /**
     * A custom localStorage implementation. Mainly relevant for testing.
     */
    localStorage?: Storage;

    /**
     * If a null value would be written to localStorage, instead remove the
     * key-value pair entirely.
     */
    removeNullValues?: boolean;

    /**
     * If fallbackValue is provided, and there is no value in localStorage, sync
     * the value to localStorage. Never does anything if fallbackValue is not
     * provided on the first render.
     */
    syncFallbackOnMount?: boolean;
  }>;

export function useLocalStorage<TReturn extends JsonValue = JsonValue>(
  options: UseLocalStorageOptions<TReturn>,
): UseLocalStorageResult<TReturn> {
  const {
    key,
    fallbackValue,
    onError = console.error,
    removeNullValues = true,
    syncFallbackOnMount = false,
    localStorage = window.localStorage,
  } = options;

  const stableOnError = useEffectEvent(onError);

  // We actually need useCallback and not useEffectEvent here, because of how
  // useSyncExternalStore works. Every time useSync gets a new memory reference
  // for its subscription callback, it unsubscribes with the old callback and
  // resubscribes with the new one. We want that behavior every time the storage
  // key changes
  const subscribeToLocalStorage = useCallback<ReactSubscriptionCallback>(
    (notifyReact) => {
      const onStorageUpdate = (event: StorageEvent) => {
        // Browsers don't support granular storage subscriptions; you have to
        // subscribe to all events, and then tease out the parts you care about
        const canIgnore =
          event.storageArea !== localStorage || event.key !== key;
        if (canIgnore) {
          return;
        }

        // Using slightly wonkier syntax to force type narrowing on the values
        // so that the main check condition doesn't have to deal with nulls
        if (event.oldValue === null || event.newValue === null) {
          if (event.oldValue !== event.newValue) {
            notifyReact();
          }
          return;
        }

        try {
          const oldParsed = JSON.parse(event.oldValue);
          const newParsed = JSON.parse(event.newValue);
          if (!deepEqual(oldParsed, newParsed)) {
            notifyReact();
          }
        } catch (err) {
          stableOnError(err as Error);
        }
      };

      window.addEventListener("storage", onStorageUpdate);
      return () => window.removeEventListener("storage", onStorageUpdate);
    },
    [key, localStorage, stableOnError],
  );

  const readFromLocalStorage = (): TReturn | null => {
    const payload = localStorage.getItem(key);
    if (payload === null) {
      return null;
    }

    try {
      const parsed = JSON.parse(payload) as TReturn;
      return parsed;
    } catch (err) {
      stableOnError(err as Error);
      return null;
    }
  };

  const storageValue = useSyncExternalStore(
    subscribeToLocalStorage,
    readFromLocalStorage,
  );

  const hookValue =
    storageValue === null && fallbackValue !== undefined
      ? fallbackValue
      : storageValue;

  const setLocalStorageValue: SetLocalStorageCallback<TReturn> = useEffectEvent(
    (payload) => {
      let newValue: TReturn | null;
      if (typeof payload === "function") {
        try {
          newValue = payload(hookValue);
        } catch (err) {
          stableOnError(err as Error);
          return;
        }
      } else {
        newValue = payload;
      }

      if (newValue === null && removeNullValues) {
        localStorage.removeItem(key);
        return;
      }

      try {
        const string = JSON.stringify(newValue);
        localStorage.setItem(key, string);
      } catch (err) {
        stableOnError(err as Error);
      }
    },
  );

  // It's generally a really bad idea to have an effect that only runs on mount
  // without resolving the reactivity properly, but there are a lot of
  // useEffectEvent calls here already, and I don't want to add even more
  // overhead. Just going to silence the linter instead.
  useEffect(() => {
    const canSyncOnMount =
      syncFallbackOnMount &&
      storageValue === null &&
      fallbackValue !== undefined;
    if (!canSyncOnMount) {
      return;
    }

    const string = JSON.stringify(fallbackValue);
    localStorage.setItem(key, string);
  }, []);

  return [hookValue, setLocalStorageValue];
}

function deepEqual(v1: JsonValue, v2: JsonValue): boolean {
  // Not using Object.is here, because it's not that relevant for JSON, and it
  // also introduces edge cases for positive and negative zero
  if (v1 === v2) {
    return true;
  }

  if (typeof v1 !== "object" || typeof v2 !== "object") {
    return false;
  }

  // Writing condition like this to get better type narrowing. The very first
  // check means that when one is null, the other can't be
  if (v1 === null || v2 === null) {
    return false;
  }

  if (Array.isArray(v1)) {
    if (!Array.isArray(v2)) {
      return false;
    }

    if (v1.length !== v2.length) {
      return false;
    }

    return v1.every((el, i) => deepEqual(el, v2[i] as JsonValue));
  }

  if (Array.isArray(v2)) {
    return false;
  }

  // For some reason, the array logic isn't narrowing properly; have to do type
  // assertions
  const o1 = v1 as JsonObject;
  const o2 = v2 as JsonObject;

  if (Object.keys(o1).length !== Object.keys(o2).length) {
    return false;
  }

  for (const key in o1) {
    const objValue1 = o1[key];
    const objValue2 = o2[key];

    if (objValue1 === undefined || objValue2 === undefined) {
      return false;
    }

    if (!deepEqual(objValue1, objValue2)) {
      return false;
    }
  }

  return true;
}
