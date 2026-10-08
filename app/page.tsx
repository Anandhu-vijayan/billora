import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex h-16 items-center border-b border-black/10 px-6 sm:px-10">
        <Link href="/" className="text-lg font-semibold tracking-tight" aria-label="Billora home">
          billora<span className="text-emerald-700">.</span>
        </Link>
        <span className="ml-auto text-xs font-medium uppercase text-black/50">Invoice operations</span>
      </header>
      <section className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-6 py-20 sm:px-10">
        <p className="mb-5 text-xs font-semibold uppercase text-emerald-800">A calmer way to close the books</p>
        <h1 className="max-w-3xl text-5xl font-semibold leading-[1.06] sm:text-6xl">
          Every invoice, accounted for.
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-8 text-black/65">
          Billora is being built to help teams receive, review, and organize invoice records in one secure workspace.
        </p>
        <div className="mt-12 grid max-w-4xl gap-px border border-black/10 bg-black/10 sm:grid-cols-3">
          <div className="bg-[#f7f8f5] p-6">
            <p className="text-sm font-semibold">01 <span className="ml-2">Receive</span></p>
            <p className="mt-3 text-sm leading-6 text-black/60">Bring invoice files into a workspace with clear ownership.</p>
          </div>
          <div className="bg-[#f7f8f5] p-6">
            <p className="text-sm font-semibold">02 <span className="ml-2">Review</span></p>
            <p className="mt-3 text-sm leading-6 text-black/60">Keep extracted records private and ready for human review.</p>
          </div>
          <div className="bg-[#f7f8f5] p-6">
            <p className="text-sm font-semibold">03 <span className="ml-2">Organize</span></p>
            <p className="mt-3 text-sm leading-6 text-black/60">Group invoices by client and period for downstream reporting.</p>
          </div>
        </div>
        <p className="mt-8 text-sm text-black/50">Workspace access is not enabled yet.</p>
      </section>
      <footer className="border-t border-black/10 px-6 py-5 text-xs text-black/50 sm:px-10">
        Billora · Secure invoice operations
      </footer>
    </main>
  );
}
