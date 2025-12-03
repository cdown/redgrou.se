import { Calendar, Users, Check, Clock, MapPin } from "lucide-react";
import { sanitizeText, sanitizeUrl } from "@/lib/sanitize";
import {
  COLOUR_LIFER,
  COLOUR_YEAR_TICK,
  COLOUR_COUNTRY_TICK,
  COLOUR_LIFER_BG,
  COLOUR_YEAR_TICK_BG,
  COLOUR_COUNTRY_TICK_BG,
} from "@/lib/colours";
import { cn, formatDisplayDate } from "@/lib/utils";

const MAX_DESCRIPTION_LENGTH = 350;

interface TickBadgesProps {
  isLifer?: boolean;
  isYearTick?: boolean;
  isCountryTick?: boolean;
  className?: string;
}

function TickBadges({
  isLifer,
  isYearTick,
  isCountryTick,
  className,
}: TickBadgesProps) {
  if (!isLifer && !isYearTick && !isCountryTick) {
    return null;
  }

  return (
    <div className={cn("flex gap-1.5 flex-wrap", className)}>
      {isLifer && (
        <div
          className="flex items-center gap-1 rounded px-2 py-0.5 text-xs"
          style={{ backgroundColor: COLOUR_LIFER_BG, color: COLOUR_LIFER }}
        >
          <Check className="h-3 w-3" style={{ color: COLOUR_LIFER }} />
          <span>Lifer</span>
        </div>
      )}
      {!isLifer && isYearTick && (
        <div
          className="flex items-center gap-1 rounded px-2 py-0.5 text-xs"
          style={{ backgroundColor: COLOUR_YEAR_TICK_BG, color: COLOUR_YEAR_TICK }}
        >
          <Calendar className="h-3 w-3" style={{ color: COLOUR_YEAR_TICK }} />
          <span>Year Tick</span>
        </div>
      )}
      {!isLifer && isCountryTick && (
        <div
          className="flex items-center gap-1 rounded px-2 py-0.5 text-xs"
          style={{ backgroundColor: COLOUR_COUNTRY_TICK_BG, color: COLOUR_COUNTRY_TICK }}
        >
          <MapPin className="h-3 w-3" style={{ color: COLOUR_COUNTRY_TICK }} />
          <span>Country Tick</span>
        </div>
      )}
    </div>
  );
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function firstParagraph(text: string): string {
  const stripped = stripHtml(text);
  const para = stripped.split(/\n\n|\r\n\r\n/)[0].trim();

  if (para.length <= MAX_DESCRIPTION_LENGTH) {
    return para;
  }

  const truncated = para.slice(0, MAX_DESCRIPTION_LENGTH);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
    truncated.lastIndexOf("."),
  );

  if (lastSentenceEnd > 0) {
    return para.slice(0, lastSentenceEnd + 1);
  }

  return truncated;
}

interface SpeciesInfo {
  scientificName: string;
  commonName: string;
  wikipediaSummary: string | null;
  photoUrl: string | null;
  photoAttribution: string | null;
  inaturalistUrl: string;
  observationsCount: number | null;
}

interface SpeciesPopupProps {
  name: string;
  count: number;
  info?: SpeciesInfo | null;
  observedAt?: string;
  isLifer?: boolean;
  isYearTick?: boolean;
  isCountryTick?: boolean;
}

export function SpeciesPopup({
  name,
  count,
  info,
  observedAt,
  isLifer,
  isYearTick,
  isCountryTick,
}: SpeciesPopupProps) {
  const formattedObservedDate = formatDisplayDate(observedAt);

  if (!info) {
    const safeName = sanitizeText(name);
    return (
      <div className="w-[280px] font-sans">
        <div className="p-3">
          <div className="mb-1 text-[15px] font-semibold text-gray-900">
            {safeName}
          </div>
          <div className="text-[13px] text-gray-600">
            Failed to load species details from iNaturalist.
          </div>
        </div>
      </div>
    );
  }

  const summary = info.wikipediaSummary
    ? firstParagraph(info.wikipediaSummary)
    : null;
  const safeSummary = summary ? sanitizeText(summary) : null;
  const safeCommonName = sanitizeText(info.commonName);
  const safeScientificInfoName = sanitizeText(info.scientificName);
  const safeAttribution = sanitizeText(info.photoAttribution);
  const safePhotoUrl = sanitizeUrl(info.photoUrl);
  const safeInatUrl = sanitizeUrl(info.inaturalistUrl);
  const safeDateDisplay = formattedObservedDate
    ? sanitizeText(formattedObservedDate)
    : null;

  return (
    <div className="w-[300px] overflow-hidden rounded-lg font-sans">
      {safePhotoUrl ? (
        <div className="relative">
          {/* Using regular img tag instead of Next.js Image because:
              - Images are already optimized by iNaturalist and served from their CDN
              - No server-side optimization needed, avoiding server load and SSRF risks
              - Images load directly client-side from iNaturalist's fast CDN */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={safePhotoUrl}
            alt={safeCommonName}
            className="h-40 w-full object-cover"
          />
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 px-3">
            <div className="text-base font-semibold text-white">
              {safeCommonName}
            </div>
            <div className="text-[13px] italic text-white/85">
              {safeScientificInfoName}
            </div>
          </div>
        </div>
      ) : (
        <div className="px-3 pt-3">
          <div className="text-base font-semibold text-gray-900">
            {safeCommonName}
          </div>
          <div className="text-[13px] italic text-gray-600">
            {safeScientificInfoName}
          </div>
        </div>
      )}
      <div className="p-3">
        {safeSummary && (
          <p className="mb-2.5 text-[13px] leading-relaxed text-gray-700">
            {safeSummary}
          </p>
        )}
        <div className="flex flex-col gap-2 border-t border-gray-200 pt-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1">
                <Users className="h-3.5 w-3.5 text-gray-600" />
                <span className="text-xs text-gray-600">
                  Count: {sanitizeText(String(count))}
                </span>
              </div>
              {safeDateDisplay && (
                <div className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5 text-gray-600" />
                  <span className="text-xs text-gray-600">
                    {safeDateDisplay}
                  </span>
                </div>
              )}
            </div>
            {safeInatUrl && (
              <a
                href={safeInatUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 no-underline"
              >
                iNaturalist →
              </a>
            )}
          </div>
          <TickBadges
            isLifer={isLifer}
            isYearTick={isYearTick}
            isCountryTick={isCountryTick}
          />
        </div>
        {safeAttribution && (
          <div className="mt-2 text-[10px] text-gray-400">
            Photo: {safeAttribution}
          </div>
        )}
      </div>
    </div>
  );
}

export function SpeciesPopupLoading({
  name,
  scientificName,
}: {
  name: string;
  scientificName?: string;
}) {
  return (
    <div className="w-[280px] font-sans">
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gray-100">
            <Clock className="h-4 w-4 text-gray-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-gray-900">
              {sanitizeText(name)}
            </div>
            {scientificName && (
              <div className="text-[13px] italic text-gray-600">
                {sanitizeText(scientificName)}
              </div>
            )}
          </div>
        </div>
        <div className="text-[13px] text-gray-600">Loading species info…</div>
      </div>
    </div>
  );
}
