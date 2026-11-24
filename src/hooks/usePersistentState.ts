import { useCallback, useEffect, useRef, useState } from "react";

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      fallback &&
      typeof fallback === "object" &&
      !Array.isArray(fallback)
    ) {
      return { ...(fallback as object), ...(parsed as object) } as T;
    }
    return parsed;
  } catch {
    return fallback;
  }
}

export function usePersistentState<T>(
  key: string,
  defaultValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(() => readStored(key, defaultValue));
  const keyRef = useRef(key);
  keyRef.current = key;

  const set = useCallback((value: T | ((prev: T) => T)) => {
    setState((prev) => {
      const next = typeof value === "function" ? (value as (prev: T) => T)(prev) : value;
      try {
        window.localStorage.setItem(keyRef.current, JSON.stringify(next));
      } catch {
        // Persistence is optional; the session still works.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(keyRef.current, JSON.stringify(state));
    } catch {
      // Ignore quota / privacy-mode errors.
    }
  }, [state]);

  return [state, set];
}
