"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  apiFetch,
  buildApiUrl,
  buildFilterParams,
  checkApiResponse,
  getErrorMessage,
  parseProtoResponse,
} from "@/lib/api";
import {
  UPLOAD_COUNT_ROUTE,
  UPLOAD_DETAILS_ROUTE,
  UPLOAD_SIGHTINGS_ROUTE,
} from "@/lib/generated/api_constants";
import {
  CountResponse,
  SightingsResponse as SightingsResponseDecoder,
  UploadMetadata as UploadMetadataDecoder,
} from "@/lib/proto/redgrouse_api";
import type {
  UploadMetadata as UploadMetadataMessage,
  Species,
} from "@/lib/proto/redgrouse_api";
import { UPLOAD_EVENTS_CHANNEL, type UploadBroadcastEvent } from "@/lib/uploads";
import { useFieldValues, sortCountries, sortYears } from "@/lib/hooks/fields";
import type { UseFieldValuesResult } from "@/lib/hooks/fields";

interface ErrorHandler {
  (message: string, error: unknown): void;
}

export interface UseUploadMetadataResult {
  upload: UploadMetadataMessage;
  isDeleted: boolean;
  pendingDataVersion: number | null;
  currentDataVersion: number;
  observeVersion: (version?: number | null) => void;
  refreshUpload: () => Promise<UploadMetadataMessage | null>;
  applyRemoteMetadata: (metadata: UploadMetadataMessage) => void;
  markDeleted: () => void;
}

export function useUploadMetadata(initialUpload: UploadMetadataMessage): UseUploadMetadataResult {
  const [upload, setUpload] = useState(initialUpload);
  const [pendingDataVersion, setPendingDataVersion] = useState<number | null>(null);
  const [isDeleted, setIsDeleted] = useState(false);
  const uploadId = initialUpload.uploadId;

  const currentDataVersion = upload.dataVersion ?? 1;

  const observeVersion = useCallback(
    (version?: number | null) => {
      if (typeof version !== "number") {
        return;
      }
      if (version > currentDataVersion) {
        setPendingDataVersion((prev) => {
          if (prev && prev >= version) {
            return prev;
          }
          return version;
        });
      }
    },
    [currentDataVersion],
  );

  const applyRemoteMetadata = useCallback((metadata: UploadMetadataMessage) => {
    setUpload(metadata);
    setPendingDataVersion(null);
    setIsDeleted(false);
  }, []);

  const markDeleted = useCallback(() => {
    setIsDeleted(true);
  }, []);

  const refreshUpload = useCallback(async () => {
    const res = await apiFetch(buildApiUrl(UPLOAD_DETAILS_ROUTE, { upload_id: uploadId }));
    if (res.status === 404) {
      setIsDeleted(true);
      return null;
    }
    await checkApiResponse(res, "Failed to refresh upload");
    const data = await parseProtoResponse(res, UploadMetadataDecoder);
    applyRemoteMetadata(data);
    return data;
  }, [applyRemoteMetadata, uploadId]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
      return;
    }
    const channel = new BroadcastChannel(UPLOAD_EVENTS_CHANNEL);
    channel.onmessage = (event: MessageEvent<UploadBroadcastEvent>) => {
      const payload = event.data;
      if (!payload || payload.uploadId !== uploadId) {
        return;
      }
      if (payload.type === "updated") {
        observeVersion(payload.dataVersion ?? null);
      } else if (payload.type === "deleted") {
        setIsDeleted(true);
      }
    };

    return () => channel.close();
  }, [uploadId, observeVersion]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let cancelled = false;

    const poll = () => {
      if (cancelled || document.hidden || isDeleted) {
        return;
      }

      apiFetch(buildApiUrl(UPLOAD_DETAILS_ROUTE, { upload_id: uploadId }))
        .then(async (res) => {
          if (res.status === 404) {
            setIsDeleted(true);
            return null;
          }
          await checkApiResponse(res, "Upload not found");
          return parseProtoResponse(res, UploadMetadataDecoder);
        })
        .then((data) => {
          if (!data) return;
          observeVersion(data.dataVersion);
        })
        .catch((err) => {
          const message = getErrorMessage(err, "Failed to check upload status");
          if (message === "Upload not found") {
            setIsDeleted(true);
          }
        });
    };

    const interval = window.setInterval(poll, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [uploadId, observeVersion, isDeleted]);

  return {
    upload,
    isDeleted,
    pendingDataVersion,
    currentDataVersion,
    observeVersion,
    refreshUpload,
    applyRemoteMetadata,
    markDeleted,
  };
}

interface FilteredCountOptions {
  filterString: string | null;
  tickFilterParam: string | null;
  yearTickYear: number | null;
  countryTickCountry: string | null;
  enabled?: boolean;
  onMissingBitmap?: (message: string) => void;
  onError?: ErrorHandler;
  onUploadDeleted?: () => void;
  onVersionObserved?: (version?: number | null) => void;
}

export interface UseFilteredCountResult {
  count: number | null;
  isLoading: boolean;
  error: string | null;
}

export function useFilteredCount(
  uploadId: string | null,
  options: FilteredCountOptions,
): UseFilteredCountResult {
  const {
    filterString,
    tickFilterParam,
    yearTickYear,
    countryTickCountry,
    enabled = true,
    onMissingBitmap,
    onError,
    onUploadDeleted,
    onVersionObserved,
  } = options;

  const [count, setCount] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!uploadId || !enabled) {
      setCount(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    const params = buildFilterParams(
      filterString,
      tickFilterParam,
      yearTickYear,
      countryTickCountry,
    );
    const url = `${buildApiUrl(UPLOAD_COUNT_ROUTE, { upload_id: uploadId })}?${params}`;

    apiFetch(url)
      .then(async (res) => {
        if (!res.ok) {
          const { getApiErrorInfo } = await import("@/lib/api");
          const errorInfo = await getApiErrorInfo(res, "Failed to load filtered count");
          if (errorInfo.code === "MISSING_BITMAP") {
            if (!cancelled) {
              onMissingBitmap?.(errorInfo.message);
              setCount(null);
              setError(errorInfo.message);
            }
            return null;
          }
          if (res.status === 404 && errorInfo.message === "Upload not found") {
            onUploadDeleted?.();
            return null;
          }
          const error = new Error(errorInfo.message) as { apiErrorCode?: string };
          if (errorInfo.code) {
            error.apiErrorCode = errorInfo.code;
          }
          throw error;
        }
        return parseProtoResponse(res, CountResponse);
      })
      .then((data) => {
        if (!data || cancelled) return;
        onVersionObserved?.(data.dataVersion);
        setCount(Number(data.count));
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = getErrorMessage(err, "Failed to load filtered count");
        setCount(null);
        setError(message);
        if (message === "Upload not found") {
          onUploadDeleted?.();
          return;
        }
        onError?.(message, err);
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
      setCount(null);
    };
  }, [
    uploadId,
    enabled,
    filterString,
    tickFilterParam,
    yearTickYear,
    countryTickCountry,
    onMissingBitmap,
    onError,
    onUploadDeleted,
    onVersionObserved,
  ]);

  return { count, isLoading, error };
}

interface UseNameIndexOptions {
  enabled?: boolean;
  onError?: ErrorHandler;
  onUploadDeleted?: () => void;
  onVersionObserved?: (version?: number | null) => void;
}

export interface UseNameIndexResult {
  nameIndex: Species[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<Species[] | null>;
}

export function useNameIndex(
  uploadId: string | null,
  options: UseNameIndexOptions = {},
): UseNameIndexResult {
  const { enabled = true, onError, onUploadDeleted, onVersionObserved } = options;
  const [nameIndex, setNameIndex] = useState<Species[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchNameIndex = useCallback(async () => {
    if (!uploadId) {
      return null;
    }

    const params = new URLSearchParams();
    params.set("page_size", "1");
    const url = `${buildApiUrl(UPLOAD_SIGHTINGS_ROUTE, { upload_id: uploadId })}?${params}`;

    const res = await apiFetch(url);
    if (res.status === 404) {
      throw new Error("Upload not found");
    }
    await checkApiResponse(res, "Failed to load species names");
    const data = await parseProtoResponse(res, SightingsResponseDecoder);
    onVersionObserved?.(data.dataVersion);
    setNameIndex(data.nameIndex);
    setError(null);
    return data.nameIndex;
  }, [uploadId, onVersionObserved]);

  const refresh = useCallback(async () => {
    try {
      return await fetchNameIndex();
    } catch (err) {
      const message = getErrorMessage(err, "Failed to load species names");
      setError(message);
      onError?.(message, err);
      throw err;
    }
  }, [fetchNameIndex, onError]);

  const shouldFetch = Boolean(uploadId) && enabled;

  useEffect(() => {
    if (!shouldFetch) {
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }
      setIsLoading(true);
      fetchNameIndex()
        .catch((err) => {
          if (cancelled) return;
          const message = getErrorMessage(err, "Failed to load species names");
          setError(message);
          if (message === "Upload not found") {
            onUploadDeleted?.();
          } else {
            onError?.(message, err);
          }
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
  }, [shouldFetch, fetchNameIndex, onError, onUploadDeleted]);

  return {
    nameIndex: shouldFetch ? nameIndex : [],
    isLoading: shouldFetch ? isLoading : false,
    error: shouldFetch ? error : null,
    refresh,
  };
}

interface FieldDataOptions {
  enabled?: boolean;
  onError?: ErrorHandler;
}

interface YearResult {
  years: number[];
  dataVersion: number | null;
  isLoading: boolean;
  error: string | null;
  refresh: UseFieldValuesResult["refresh"];
}

export function useYears(uploadId: string | null, options: FieldDataOptions = {}): YearResult {
  const { values, dataVersion, isLoading, error, refresh } = useFieldValues(
    uploadId,
    "year",
    {
      enabled: options.enabled,
      sort: sortYears,
      onError: options.onError,
    },
  );

  const years = useMemo(
    () =>
      values
        .map((value) => parseInt(value, 10))
        .filter((value) => Number.isFinite(value)),
    [values],
  );

  return { years, dataVersion, isLoading, error, refresh };
}

interface CountryResult {
  countries: string[];
  dataVersion: number | null;
  isLoading: boolean;
  error: string | null;
  refresh: UseFieldValuesResult["refresh"];
}

export function useCountries(
  uploadId: string | null,
  options: FieldDataOptions = {},
): CountryResult {
  const { values, dataVersion, isLoading, error, refresh } = useFieldValues(
    uploadId,
    "country_code",
    {
      enabled: options.enabled,
      sort: sortCountries,
      onError: options.onError,
    },
  );

  const countries = useMemo(
    () =>
      values.filter(
        (code) =>
          code &&
          code.trim().length > 0 &&
          code.toUpperCase() !== "XX",
      ),
    [values],
  );

  return { countries, dataVersion, isLoading, error, refresh };
}
