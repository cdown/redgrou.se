"use client";

import { useState } from "react";
import { HelpCircle, X } from "lucide-react";
import {
  COLOUR_LIFER,
  COLOUR_YEAR_TICK,
  COLOUR_COUNTRY_TICK,
  COLOUR_NORMAL_SIGHTING,
  COLOUR_WHITE,
} from "@/lib/colours";

interface ColorLegendProps {
  filterOpen?: boolean;
}

export function ColorLegend({ filterOpen = false }: ColorLegendProps) {
  const [isOpen, setIsOpen] = useState(false);
  const effectiveIsOpen = isOpen && !filterOpen;

  const handleToggle = () => {
    if (filterOpen) return;
    setIsOpen(!isOpen);
  };

  const legendItems = [
    {
      color: COLOUR_LIFER,
      label: "Lifer",
      description: "First sighting of this species",
    },
    {
      color: COLOUR_YEAR_TICK,
      label: "Year tick",
      description: "First sighting this year",
    },
    {
      color: COLOUR_COUNTRY_TICK,
      label: "Country tick",
      description: "First sighting in this country",
    },
    {
      color: COLOUR_NORMAL_SIGHTING,
      label: "Normal sighting",
      description: "Regular observation",
    },
  ];

  return (
    <div
      className={`absolute bottom-4 left-4 z-50 transition-opacity ${
        filterOpen ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
    >
      {!effectiveIsOpen ? (
        <button
          onClick={handleToggle}
          className="flex h-10 w-10 items-center justify-center rounded-lg bg-white text-stone-600 shadow-lg transition-all hover:bg-stone-50 hover:scale-105"
          title="Show colour legend"
          aria-label="Show colour legend"
        >
          <HelpCircle className="h-5 w-5" />
        </button>
      ) : (
        <div className="rounded-lg bg-white shadow-lg transition-all duration-200">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h3 className="text-sm font-semibold text-stone-900">Colour legend</h3>
            <button
              onClick={() => setIsOpen(false)}
              className="flex h-6 w-6 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
              aria-label="Close legend"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="p-4">
            <div className="space-y-3">
              {legendItems.map((item) => (
                <div key={item.label} className="flex items-start gap-3">
                  <div
                    className="mt-0.5 h-6 w-6 shrink-0 rounded-full shadow-sm"
                    style={{
                      backgroundColor: item.color,
                      border: `1.5px solid ${COLOUR_WHITE}`,
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-stone-900">
                      {item.label}
                    </div>
                    <div className="text-xs text-stone-500">
                      {item.description}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

