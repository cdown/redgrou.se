"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { TrendingUp } from "lucide-react";
import type { TimelinePoint } from "@/lib/proto/redgrouse_api";

interface TimelineChartsProps {
  lifersTimeline: TimelinePoint[];
  sightingsTimeline: TimelinePoint[];
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-GB", { year: "numeric", month: "short" });
  } catch {
    return dateStr;
  }
}

function downsampleData(data: TimelinePoint[], maxPoints: number = 100): TimelinePoint[] {
  if (data.length <= maxPoints) {
    return data;
  }

  const step = Math.ceil(data.length / maxPoints);
  const downsampled: TimelinePoint[] = [];

  for (let i = 0; i < data.length; i += step) {
    downsampled.push(data[i]);
  }

  if (downsampled[downsampled.length - 1] !== data[data.length - 1]) {
    downsampled.push(data[data.length - 1]);
  }

  return downsampled;
}

export function TimelineCharts({ lifersTimeline, sightingsTimeline }: TimelineChartsProps) {
  if (lifersTimeline.length === 0 || sightingsTimeline.length === 0) {
    return null;
  }

  const lifersData = downsampleData(lifersTimeline).map((point) => ({
    date: point.date,
    value: Number(point.count),
    formattedDate: formatDate(point.date),
  }));

  const sightingsData = downsampleData(sightingsTimeline).map((point) => ({
    date: point.date,
    value: Number(point.count),
    formattedDate: formatDate(point.date),
  }));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="rounded-xl bg-white p-6 shadow-lg ring-1 ring-stone-900/5">
        <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-stone-900">
          <TrendingUp className="h-5 w-5 text-rose-600" />
          Lifers Over Time
        </h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={lifersData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
              <XAxis
                dataKey="formattedDate"
                tick={{ fontSize: 12, fill: "#78716c" }}
                tickLine={{ stroke: "#e7e5e4" }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 12, fill: "#78716c" }}
                tickLine={{ stroke: "#e7e5e4" }}
                axisLine={{ stroke: "#e7e5e4" }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#fff",
                  border: "1px solid #e7e5e4",
                  borderRadius: "8px",
                  fontSize: "14px",
                }}
                labelStyle={{ color: "#57534e", fontWeight: 600 }}
                itemStyle={{ color: "#f43f5e" }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#f43f5e"
                strokeWidth={2}
                dot={false}
                name="Lifers"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-xl bg-white p-6 shadow-lg ring-1 ring-stone-900/5">
        <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-stone-900">
          <TrendingUp className="h-5 w-5 text-amber-600" />
          Sightings Over Time
        </h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sightingsData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
              <XAxis
                dataKey="formattedDate"
                tick={{ fontSize: 12, fill: "#78716c" }}
                tickLine={{ stroke: "#e7e5e4" }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 12, fill: "#78716c" }}
                tickLine={{ stroke: "#e7e5e4" }}
                axisLine={{ stroke: "#e7e5e4" }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#fff",
                  border: "1px solid #e7e5e4",
                  borderRadius: "8px",
                  fontSize: "14px",
                }}
                labelStyle={{ color: "#57534e", fontWeight: 600 }}
                itemStyle={{ color: "#f59e0b" }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={false}
                name="Sightings"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
