"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  apiFetch,
  buildApiUrl,
  checkApiResponse,
  getErrorMessage,
  parseProtoResponse,
} from "@/lib/api";
import { FIELD_VALUES_ROUTE } from "@/lib/generated/api_constants";
import { FieldValues as FieldValuesDecoder } from "@/lib/proto/redgrouse_api";
import { getCountryName } from "@/lib/countries";

type ErrorHandler = (message: string, error: unknown) => void;

export interface FieldValuesEntry {
  values: string[];
  dataVersion: number | null;
}

const fieldValuesCache = new Map<string, FieldValuesEntry>();

export interface UseFieldValuesOptions {
  enabled?: boolean;
  sort?: (values: string[]) => string[];
  onError?: ErrorHandler;
}

export interface UseFieldValuesResult {
  values: string[];
  dataVersion: number | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<FieldValuesEntry | null>;
}

export function useFieldValues(
  uploadId: string | null | undefined,
  field: string | null | undefined,
  options: UseFieldValuesOptions = {},
): UseFieldValuesResult {
  const { enabled = true, sort, onError } = options;
  const cacheKey = uploadId && field ? `${uploadId}:${field}` : null;
  const [entry, setEntry] = useState<FieldValuesEntry | null>(() =>
    cacheKey ? fieldValuesCache.get(cacheKey) ?? null : null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shouldFetch = Boolean(cacheKey) && enabled;

  const fetchValues = useCallback(async () => {
    if (!uploadId || !field) {
      return null;
    }

    const url = buildApiUrl(FIELD_VALUES_ROUTE, {
      upload_id: uploadId,
      field,
    });
    const res = await apiFetch(url);
    await checkApiResponse(res, "Failed to load field values");
    const data = await parseProtoResponse(res, FieldValuesDecoder);
    const nextEntry: FieldValuesEntry = {
      values: data.values,
      dataVersion: data.dataVersion ?? null,
    };
    if (cacheKey) {
      fieldValuesCache.set(cacheKey, nextEntry);
    }
    return nextEntry;
  }, [cacheKey, uploadId, field]);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchValues();
      setEntry(result);
      setError(null);
      return result;
    } catch (err) {
      const message = getErrorMessage(err, "Failed to load field values");
      setError(message);
      onError?.(message, err);
      throw err;
    }
  }, [fetchValues, onError]);

  useEffect(() => {
    if (!shouldFetch || !cacheKey) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }
      const cached = fieldValuesCache.get(cacheKey);
      if (cached) {
        setEntry(cached);
        setError(null);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      fetchValues()
        .then((result) => {
          if (cancelled) return;
          setEntry(result);
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          const message = getErrorMessage(err, "Failed to load field values");
          setError(message);
          onError?.(message, err);
        })
        .finally(() => {
          if (!cancelled) {
            setIsLoading(false);
          }
        });
    });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, fetchValues, onError, shouldFetch]);

  const sortedValues = useMemo(() => {
    if (!shouldFetch || !entry) {
      return [];
    }
    if (sort) {
      return sort([...entry.values]);
    }
    return entry.values;
  }, [entry, sort, shouldFetch]);

  return {
    values: sortedValues,
    dataVersion: shouldFetch ? entry?.dataVersion ?? null : null,
    isLoading: shouldFetch ? isLoading : false,
    error: shouldFetch ? error : null,
    refresh,
  };
}

export function sortYears(values: string[]): string[] {
  return values
    .map((value) => ({ raw: value, numeric: parseInt(value, 10) }))
    .filter((item) => !Number.isNaN(item.numeric))
    .sort((a, b) => b.numeric - a.numeric)
    .map((item) => item.raw);
}

export function sortCountries(values: string[]): string[] {
  return values
    .filter((code) => code && code.trim().length > 0)
    .sort((a, b) => {
      if (a === "XX") return 1;
      if (b === "XX") return -1;
      const nameA = getCountryName(a);
      const nameB = getCountryName(b);
      return nameA.localeCompare(nameB);
    });
}
