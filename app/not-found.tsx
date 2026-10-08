import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-semibold text-emerald-800">404 · Billora</p>
      <h1 className="mt-4 text-3xl font-semibold">That page isn’t here.</h1>
      <p className="mt-3 text-sm text-black/60">The address may be incorrect or the page may have moved.</p>
      <Link
        className="mt-7 border border-black/20 px-4 py-2 text-sm font-medium hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
        href="/"
      >
        Return home
      </Link>
    </main>
  );
}