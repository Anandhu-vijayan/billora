"use client";

import "./globals.css";

export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
          <p className="text-sm font-semibold text-emerald-800">Billora</p>
          <h1 className="mt-4 text-3xl font-semibold">We couldn’t load this page.</h1>
          <p className="mt-3 max-w-md text-sm leading-6 text-black/60">
            Something went wrong while processing your request. Try again, or come back in a moment.
          </p>
          <button
            className="mt-7 border border-black/20 px-4 py-2 text-sm font-medium hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
            onClick={() => reset()}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}