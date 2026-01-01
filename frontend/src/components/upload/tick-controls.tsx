"use client";

import { ReactNode } from "react";
import { Calendar, ChevronDown, List, Map as MapIcon, BarChart3 } from "lucide-react";
import { getCountryName } from "@/lib/countries";

interface TickControlsProps {
  tickButton: ReactNode;
  availableYears: number[];
  selectedYear: number | null;
  onYearChange: (year: number | null) => void;
  availableCountries: string[];
  selectedCountry: string | null;
  onCountryChange: (country: string | null) => void;
  viewMode: "map" | "table" | "stats";
  onViewModeChange: (mode: "map" | "table" | "stats") => void;
}

export function TickControls({
  tickButton,
  availableYears,
  selectedYear,
  onYearChange,
  availableCountries,
  selectedCountry,
  onCountryChange,
  viewMode,
  onViewModeChange,
}: TickControlsProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col sm:flex-row flex-wrap gap-2">
        {tickButton}
        {availableYears.length > 0 && (
          <div className="relative flex-1 sm:flex-initial min-w-0">
            <select
              value={selectedYear ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                onYearChange(value ? parseInt(value, 10) : null);
              }}
              className={`w-full flex items-center gap-2 rounded-lg pl-9 pr-8 py-2 text-sm font-medium transition-colors shadow-lg cursor-pointer ${
                selectedYear ? "bg-stone-900 text-white" : "bg-white text-stone-600 hover:bg-stone-50"
              }`}
              style={{ appearance: "none" }}
            >
              {selectedYear ? (
                <option value="">Clear</option>
              ) : (
                <option value="">Year tick</option>
              )}
              {availableYears.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2">
              <Calendar className={`h-4 w-4 ${selectedYear ? "text-white" : "text-stone-600"}`} />
            </div>
            <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
              <ChevronDown className={`h-3 w-3 ${selectedYear ? "text-white" : "text-stone-400"}`} />
            </div>
          </div>
        )}
        {availableCountries.length > 0 && (
          <div className="relative flex-1 sm:flex-initial min-w-0">
            <select
              value={selectedCountry ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                onCountryChange(value || null);
              }}
              className={`w-full flex items-center gap-2 rounded-lg pl-9 pr-8 py-2 text-sm font-medium transition-colors shadow-lg cursor-pointer ${
                selectedCountry
                  ? "bg-stone-900 text-white"
                  : "bg-white text-stone-600 hover:bg-stone-50"
              }`}
              style={{ appearance: "none" }}
            >
              {selectedCountry ? (
                <option value="">Clear</option>
              ) : (
                <option value="">Country tick</option>
              )}
              {availableCountries.map((code) => (
                <option key={code} value={code}>
                  {getCountryName(code)}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2">
              <MapIcon className={`h-4 w-4 ${selectedCountry ? "text-white" : "text-stone-600"}`} />
            </div>
            <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
              <ChevronDown className={`h-3 w-3 ${selectedCountry ? "text-white" : "text-stone-400"}`} />
            </div>
          </div>
        )}
      </div>

      <div className="flex overflow-hidden rounded-lg bg-white shadow-lg">
        <button
          onClick={() => onViewModeChange("map")}
          className={`flex flex-1 items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            viewMode === "map" ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-50"
          }`}
        >
          <MapIcon className="h-4 w-4" />
          Map
        </button>
        <button
          onClick={() => onViewModeChange("table")}
          className={`flex flex-1 items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            viewMode === "table" ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-50"
          }`}
        >
          <List className="h-4 w-4" />
          List
        </button>
        <button
          onClick={() => onViewModeChange("stats")}
          className={`flex flex-1 items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            viewMode === "stats" ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-50"
          }`}
        >
          <BarChart3 className="h-4 w-4" />
          Stats
        </button>
      </div>
    </div>
  );
}
