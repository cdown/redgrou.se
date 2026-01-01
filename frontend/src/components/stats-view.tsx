"use client";

import { useEffect, useState } from "react";
import {
  Sparkles,
  Eye,
  Bird,
  Clock,
  Globe,
  Calendar,
  MapPin,
  Award,
  Sunrise,
  Flame,
} from "lucide-react";
import { getCountryName } from "@/lib/countries";
import type { StatsResponse, SpeciesCount, CountryStats } from "@/lib/proto/redgrouse_api";
import { TimelineCharts } from "@/components/stats/timeline-charts";

interface StatsViewProps {
  stats: StatsResponse | null;
  isLoading: boolean;
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) {
    return `${mins}m`;
  }
  if (mins === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${mins}m`;
}

function formatDate(isoDate: string | undefined): string {
  if (!isoDate) {
    return "N/A";
  }
  try {
    return new Date(isoDate).toLocaleDateString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "N/A";
  }
}

function AnimatedNumber({ value }: { value: number }) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    const duration = 1000;
    const steps = 50;
    const increment = value / steps;
    const stepDuration = duration / steps;

    let current = 0;
    const timer = setInterval(() => {
      current += increment;
      if (current >= value) {
        setDisplayValue(value);
        clearInterval(timer);
      } else {
        setDisplayValue(Math.floor(current));
      }
    }, stepDuration);

    return () => clearInterval(timer);
  }, [value]);

  return <>{displayValue.toLocaleString()}</>;
}

function StatCard({
  icon: Icon,
  label,
  value,
  subtitle,
  colour = "rose",
  animated = false,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  subtitle?: string;
  colour?: "rose" | "amber" | "emerald" | "blue" | "purple" | "stone";
  animated?: boolean;
}) {
  const colourClasses = {
    rose: "from-rose-500 to-rose-600 shadow-rose-500/25",
    amber: "from-amber-500 to-amber-600 shadow-amber-500/25",
    emerald: "from-emerald-500 to-emerald-600 shadow-emerald-500/25",
    blue: "from-blue-500 to-blue-600 shadow-blue-500/25",
    purple: "from-purple-500 to-purple-600 shadow-purple-500/25",
    stone: "from-stone-500 to-stone-600 shadow-stone-500/25",
  };

  return (
    <div className="rounded-xl bg-white p-6 shadow-lg ring-1 ring-stone-900/5">
      <div className="flex items-start gap-4">
        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${colourClasses[colour]} shadow-lg`}
        >
          <Icon className="h-6 w-6 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-stone-600">{label}</p>
          <p className="mt-1 text-3xl font-bold tracking-tight text-stone-900">
            {animated && typeof value === "number" ? <AnimatedNumber value={value} /> : value}
          </p>
          {subtitle && <p className="mt-1 text-sm text-stone-500">{subtitle}</p>}
        </div>
      </div>
    </div>
  );
}

function TopSpeciesList({ species }: { species: SpeciesCount[] }) {
  if (species.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-lg ring-1 ring-stone-900/5">
      <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-stone-900">
        <Bird className="h-5 w-5 text-rose-600" />
        Most Seen Species
      </h3>
      <div className="max-h-96 space-y-3 overflow-y-auto">
        {species.slice(0, 200).map((sp, idx) => (
          <div key={`${sp.commonName}-${idx}`} className="flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-stone-900">{sp.commonName}</p>
              {sp.scientificName && (
                <p className="truncate text-sm italic text-stone-500">{sp.scientificName}</p>
              )}
            </div>
            <div className="ml-4 flex shrink-0 items-center gap-2">
              <span className="rounded-full bg-stone-100 px-3 py-1 text-sm font-semibold text-stone-700">
                {Number(sp.count).toLocaleString()} {Number(sp.count) === 1 ? "sighting" : "sightings"}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CountryStatsList({ countryStats }: { countryStats: CountryStats[] }) {
  if (countryStats.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-lg ring-1 ring-stone-900/5">
      <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-stone-900">
        <Globe className="h-5 w-5 text-blue-600" />
        Countries Visited
      </h3>
      <div className="max-h-96 space-y-3 overflow-y-auto">
        {countryStats.slice(0, 200).map((country, idx) => (
          <div key={`${country.countryCode}-${idx}`} className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl">{getFlagEmoji(country.countryCode)}</span>
              <div>
                <p className="font-medium text-stone-900">{getCountryName(country.countryCode)}</p>
                <p className="text-sm text-stone-500">
                  {Number(country.sightings).toLocaleString()} {Number(country.sightings) === 1 ? "sighting" : "sightings"}
                </p>
              </div>
            </div>
            <div className="ml-4 flex shrink-0 items-center gap-2">
              <span className="rounded-full bg-stone-100 px-3 py-1 text-sm font-semibold text-stone-700">
                {Number(country.lifers).toLocaleString()} {Number(country.lifers) === 1 ? "lifer" : "lifers"}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function getFlagEmoji(countryCode: string): string {
  if (!countryCode || countryCode.length !== 2) {
    return "🌍";
  }
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 p-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="h-32 animate-pulse rounded-xl bg-stone-200"
          />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[...Array(2)].map((_, i) => (
          <div
            key={i}
            className="h-96 animate-pulse rounded-xl bg-stone-200"
          />
        ))}
      </div>
    </div>
  );
}

export function StatsView({ stats, isLoading }: StatsViewProps) {
  if (isLoading || !stats) {
    return <LoadingSkeleton />;
  }

  const totalSightings = Number(stats.totalSightings);
  const totalLifers = Number(stats.totalLifers);
  const totalSpecies = Number(stats.totalSpecies);
  const hoursMinutes = Number(stats.hoursBirdingMinutes);
  const totalCountries = Number(stats.totalCountries);
  const totalYearTicks = Number(stats.totalYearTicks);
  const totalCountryTicks = Number(stats.totalCountryTicks);
  const totalIndividuals = Number(stats.totalIndividuals);
  const totalDistanceKm = stats.totalDistanceKm ? Number(stats.totalDistanceKm) : null;

  const avgBirdsPerSighting =
    totalSightings > 0 ? (totalIndividuals / totalSightings).toFixed(1) : "0";

  const yearSpan = stats.firstSightingDate && stats.latestSightingDate
    ? (() => {
        try {
          const first = new Date(stats.firstSightingDate).getFullYear();
          const latest = new Date(stats.latestSightingDate).getFullYear();
          const years = latest - first + 1;
          return years === 1 ? "1 year" : `${years} years`;
        } catch {
          return null;
        }
      })()
    : null;

  return (
    <div className="h-full overflow-y-auto bg-gradient-to-br from-stone-50 to-stone-100 p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="mb-8">
          <h2 className="text-3xl font-bold tracking-tight text-stone-900">Life Stats</h2>
          <p className="mt-2 text-stone-600">Birding journey at a glance</p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={Sparkles}
            label="Lifers"
            value={totalLifers}
            colour="rose"
            animated={true}
          />
          <StatCard
            icon={Eye}
            label="Total Sightings"
            value={totalSightings}
            colour="amber"
            animated={true}
          />
          <StatCard
            icon={Flame}
            label="Longest Streak"
            value={`${stats.longestStreakDays} ${stats.longestStreakDays === 1 ? "day" : "days"}`}
            colour="emerald"
            animated={true}
          />
          <StatCard
            icon={Clock}
            label="Time Birding"
            value={formatDuration(hoursMinutes)}
            colour="blue"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={Globe}
            label="Countries"
            value={totalCountries}
            colour="purple"
            animated={true}
          />
          <StatCard
            icon={Bird}
            label="Individuals Seen"
            value={totalIndividuals}
            colour="stone"
            animated={true}
            subtitle={`Avg ${avgBirdsPerSighting} per sighting`}
          />
          <StatCard
            icon={Calendar}
            label="Year Ticks"
            value={totalYearTicks}
            colour="amber"
            animated={true}
          />
          <StatCard
            icon={MapPin}
            label="Country Ticks"
            value={totalCountryTicks}
            colour="emerald"
            animated={true}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            icon={Sunrise}
            label="First Sighting"
            value={formatDate(stats.firstSightingDate)}
            colour="amber"
          />
          <StatCard
            icon={Calendar}
            label="Latest Sighting"
            value={formatDate(stats.latestSightingDate)}
            colour="blue"
          />
          {yearSpan && (
            <StatCard
              icon={Award}
              label="Years Birding"
              value={yearSpan}
              colour="purple"
            />
          )}
        </div>

        <TimelineCharts
          lifersTimeline={stats.lifersTimeline}
          sightingsTimeline={stats.sightingsTimeline}
        />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <TopSpeciesList species={stats.topSpecies} />
          <CountryStatsList countryStats={stats.countryStats} />
        </div>

        {totalSightings > 0 && stats.firstSightingDate && (
          <div className="rounded-xl bg-gradient-to-r from-rose-50 to-amber-50 p-6 shadow-lg ring-1 ring-stone-900/5">
            <p className="text-center text-lg leading-relaxed text-stone-700">
              <span className="font-semibold">
                Birding for {yearSpan || "some time"}
              </span>
              , with <span className="font-semibold">{totalSightings.toLocaleString()} sightings</span> across{" "}
              <span className="font-semibold">{totalCountries.toLocaleString()} {totalCountries === 1 ? "country" : "countries"}</span>.
              {stats.topSpecies.length > 0 && (
                <>
                  {" "}The most frequently seen species is{" "}
                  <span className="font-semibold">{stats.topSpecies[0].commonName}</span> with{" "}
                  <span className="font-semibold">{Number(stats.topSpecies[0].count).toLocaleString()} sightings</span>!
                </>
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
