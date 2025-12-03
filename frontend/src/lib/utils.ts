import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

const DISPLAY_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
}

function normaliseDate(value: string | Date | null | undefined): Date | null {
  if (!value) {
    return null
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDisplayDate(
  value: string | Date | null | undefined,
  locale = "en-GB",
  options: Intl.DateTimeFormatOptions = DISPLAY_DATE_OPTIONS,
) {
  const date = normaliseDate(value)
  if (!date) {
    return typeof value === "string" ? value : ""
  }
  return date.toLocaleDateString(locale, options)
}
