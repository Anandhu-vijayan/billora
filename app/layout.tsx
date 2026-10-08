import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  applicationName: 'Billora',
  title: {
    default: 'Billora | Invoice operations',
    template: '%s | Billora',
  },
  description: 'A secure workspace for receiving, reviewing, and organizing invoices.',
  openGraph: {
    title: 'Billora | Invoice operations',
    description: 'A secure workspace for receiving, reviewing, and organizing invoices.',
    siteName: 'Billora',
    type: 'website',
  },
  robots: {
    index: false,
    follow: false,
  },
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}


