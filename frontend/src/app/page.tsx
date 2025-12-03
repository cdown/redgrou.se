"use client";

import { useRouter } from "next/navigation";
import { Map, Filter, Link } from "lucide-react";
import { UploadForm } from "@/components/upload-form";

export default function Home() {
  const router = useRouter();

  return (
    <main className="fixed inset-0 overflow-hidden">
      {/* Background with subtle topographic pattern */}
      <div className="absolute inset-0 bg-gradient-to-br from-stone-50 via-amber-50/30 to-rose-50/40" />
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg stroke='%23000' stroke-width='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
        }}
      />

      {/* Decorative circles */}
      <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-gradient-to-br from-rose-200/30 to-transparent blur-3xl" />
      <div className="absolute -bottom-48 -right-48 h-[500px] w-[500px] rounded-full bg-gradient-to-tl from-amber-200/40 to-transparent blur-3xl" />

      {/* Content */}
      <div className="relative flex h-full items-center justify-center p-6">
        <div className="w-full max-w-md">
          {/* Logo */}
          <div className="mb-8 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-rose-500 to-rose-600 shadow-lg shadow-rose-500/25">
              <Map className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-stone-900">
                redgrou.se
              </h1>
              <p className="text-sm text-stone-500">Bird sighting analytics</p>
            </div>
          </div>

          {/* Upload card */}
          <div className="rounded-2xl bg-white/80 p-6 shadow-xl shadow-stone-900/5 ring-1 ring-stone-900/5 backdrop-blur-sm">
            <h2 className="mb-2 text-lg font-semibold text-stone-900">
              Visualise your sightings
            </h2>
            <p className="mb-6 text-sm text-stone-600">
              Upload a CSV export from Birda to see your observations on an
              interactive map.
            </p>
            <UploadForm
              onUploadComplete={(result) =>
                router.push(`/single/${result.upload_id}`)
              }
            />
          </div>

          {/* Features */}
          <div className="mt-8 grid grid-cols-3 gap-4 text-center">
            <div className="rounded-xl bg-white/50 p-4 backdrop-blur-sm">
              <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-stone-100">
                <Map className="h-[18px] w-[18px] text-stone-600" />
              </div>
              <span className="text-xs font-medium text-stone-700">
                Interactive map
              </span>
            </div>
            <div className="rounded-xl bg-white/50 p-4 backdrop-blur-sm">
              <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-stone-100">
                <Filter className="h-[18px] w-[18px] text-stone-600" />
              </div>
              <span className="text-xs font-medium text-stone-700">
                Powerful filters
              </span>
            </div>
            <div className="rounded-xl bg-white/50 p-4 backdrop-blur-sm">
              <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-stone-100">
                <Link className="h-[18px] w-[18px] text-stone-600" />
              </div>
              <span className="text-xs font-medium text-stone-700">
                Shareable links
              </span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
