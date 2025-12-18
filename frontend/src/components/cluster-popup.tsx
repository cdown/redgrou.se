import {
  COLOUR_COUNTRY_TICK,
  COLOUR_COUNTRY_TICK_BG,
  COLOUR_LIFER,
  COLOUR_LIFER_BG,
  COLOUR_YEAR_TICK,
  COLOUR_YEAR_TICK_BG,
} from "@/lib/colours";
import { formatDisplayDate } from "@/lib/utils";

export interface ClusterPopupSighting {
  id: number;
  name: string;
  scientificName?: string;
  count: number;
  observedAt?: string;
  isLifer: boolean;
  isYearTick: boolean;
  isCountryTick: boolean;
  lat: number;
  lng: number;
}

interface ClusterPopupProps {
  sightings: ClusterPopupSighting[];
  onSelect: (sighting: ClusterPopupSighting) => void;
}

function ClusterTickBadges({
  isLifer,
  isYearTick,
  isCountryTick,
}: {
  isLifer: boolean;
  isYearTick: boolean;
  isCountryTick: boolean;
}) {
  if (!isLifer && !isYearTick && !isCountryTick) {
    return null;
  }

  return (
    <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] font-medium">
      {isLifer && (
        <span
          className="rounded px-1.5 py-0.5"
          style={{ backgroundColor: COLOUR_LIFER_BG, color: COLOUR_LIFER }}
        >
          Lifer
        </span>
      )}
      {!isLifer && isYearTick && (
        <span
          className="rounded px-1.5 py-0.5"
          style={{ backgroundColor: COLOUR_YEAR_TICK_BG, color: COLOUR_YEAR_TICK }}
        >
          Year Tick
        </span>
      )}
      {!isLifer && isCountryTick && (
        <span
          className="rounded px-1.5 py-0.5"
          style={{ backgroundColor: COLOUR_COUNTRY_TICK_BG, color: COLOUR_COUNTRY_TICK }}
        >
          Country Tick
        </span>
      )}
    </div>
  );
}

export function ClusterPopup({ sightings, onSelect }: ClusterPopupProps) {
  if (!sightings.length) {
    return null;
  }

  return (
    <div className="w-[300px] max-h-[360px] overflow-y-auto p-2 font-sans">
      <div className="pb-2 text-[15px] font-semibold text-gray-900">
        {sightings.length} overlapping sightings
      </div>
      <div className="flex flex-col gap-2">
        {sightings.map((sighting) => {
          const formattedDate = formatDisplayDate(sighting.observedAt);
          return (
            <button
              key={sighting.id}
              type="button"
              onClick={() => onSelect(sighting)}
              className="rounded border border-gray-200 bg-white px-3 py-2 text-left transition hover:border-gray-300 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-300 focus:ring-offset-1"
            >
              <div className="text-sm font-medium text-gray-900">
                {sighting.name}
              </div>
              {sighting.scientificName && (
                <div className="text-xs italic text-gray-600">
                  {sighting.scientificName}
                </div>
              )}
              <div className="mt-1 text-[11px] text-gray-600">
                Count: {sighting.count}
                {formattedDate && <span className="ml-2">{formattedDate}</span>}
              </div>
              <ClusterTickBadges
                isLifer={sighting.isLifer}
                isYearTick={sighting.isYearTick}
                isCountryTick={sighting.isCountryTick}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}


