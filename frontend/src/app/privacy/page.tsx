import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "Privacy Policy | redgrou.se",
  description: "Privacy policy for redgrou.se",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-50 via-amber-50/30 to-rose-50/40">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-2 text-sm text-stone-600 hover:text-stone-900 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to home
        </Link>

        <div className="rounded-2xl bg-white/80 p-8 shadow-xl shadow-stone-900/5 ring-1 ring-stone-900/5 backdrop-blur-sm">
          <h1 className="mb-6 text-3xl font-bold tracking-tight text-stone-900">
            Privacy Policy
          </h1>

          <div className="prose prose-stone max-w-none space-y-6 text-sm leading-relaxed">
            <section>
              <h2 className="mb-3 text-xl font-semibold text-stone-900">
                Data Collection
              </h2>
              <p className="text-stone-700">
                redgrou.se collects the following data when you upload a CSV
                file:
              </p>
              <ul className="ml-6 mt-2 list-disc space-y-1 text-stone-700">
                <li>GPS coordinates (latitude and longitude)</li>
                <li>Species data (common name and scientific name)</li>
                <li>Observation dates and times</li>
                <li>Observation counts</li>
              </ul>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-stone-900">
                Data Storage
              </h2>
              <p className="text-stone-700">
                Your data is stored in a SQLite database on our server. Edit
                tokens are stored in your browser&apos;s <code className="rounded bg-stone-100 px-1.5 py-0.5 text-xs font-mono">localStorage</code> to enable
                future edits and deletions. This is strictly necessary for
                the site to function and does not require explicit consent.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-stone-900">
                Data Access
              </h2>
              <p className="text-stone-700">
                Uploads are accessible via unique URLs:
              </p>
              <ul className="ml-6 mt-2 list-disc space-y-1 text-stone-700">
                <li>
                  <strong>Public links:</strong> Anyone with the URL can view
                  your sightings and GPS coordinates without authentication
                </li>
                <li>
                  <strong>Edit tokens:</strong> Grant full edit and delete
                  access to your upload. Keep these secure and do not share them
                  publicly
                </li>
              </ul>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-stone-900">
                Third-Party Services
              </h2>
              <p className="text-stone-700">
                We use the following third-party services:
              </p>
              <ul className="ml-6 mt-2 list-disc space-y-1 text-stone-700">
                <li>
                  <strong>OpenFreeMap:</strong> Provides map tiles for the
                  interactive map display
                </li>
                <li>
                  <strong>iNaturalist API:</strong> Used to fetch species
                  metadata when available
                </li>
              </ul>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-stone-900">
                Data Deletion
              </h2>
              <p className="text-stone-700">
                You can delete your data at any time using the &quot;Delete&quot; button
                in the upload interface. This requires your edit token, which is
                stored in your browser&apos;s <code className="rounded bg-stone-100 px-1.5 py-0.5 text-xs font-mono">localStorage</code> or can be
                provided via URL parameter.
              </p>
              <p className="mt-3 text-stone-700">
                Uploads that have not been accessed in 365 days are
                automatically deleted to comply with data retention
                requirements.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-stone-900">
                Data Retention
              </h2>
              <p className="text-stone-700">
                We operate a &quot;view-to-renew&quot; retention policy:
              </p>
              <ul className="ml-6 mt-2 list-disc space-y-1 text-stone-700">
                <li>Uploads are retained for 365 days from last access</li>
                <li>Viewing an upload renews its retention period</li>
                <li>Uploads not accessed in 365 days are automatically deleted</li>
              </ul>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-stone-900">
                Your Rights
              </h2>
              <p className="text-stone-700">
                Under GDPR, you have the right to:
              </p>
              <ul className="ml-6 mt-2 list-disc space-y-1 text-stone-700">
                <li>Access your personal data</li>
                <li>Rectify inaccurate data</li>
                <li>Request deletion of your data</li>
                <li>Object to processing of your data</li>
              </ul>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-stone-900">
                Contact
              </h2>
              <p className="text-stone-700">
                To exercise your rights or request data deletion, please contact
                us at{" "}
                <a
                  href="mailto:security@chrisdown.name"
                  className="text-rose-600 hover:text-rose-700 underline"
                >
                  security@chrisdown.name
                </a>
                .
              </p>
            </section>

            <section>
              <p className="mt-8 text-xs text-stone-500">
                Last updated: {new Date().toLocaleDateString("en-GB", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </p>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

