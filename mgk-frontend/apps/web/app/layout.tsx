import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Header } from '@/components/layout/Header';
import { SolanaProvider } from '@/components/providers/SolanaProvider';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { TickerBar } from '@/components/trade/TickerBar';
import { StatusBar } from '@/components/trade/StatusBar';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'mgk — On-chain perps',
  description: 'On-chain perpetual futures with commit-reveal CLOB. Devnet.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <SolanaProvider>
            <Header />
            <TickerBar />
            <div className="flex-1 flex flex-col min-h-0">
              {children}
            </div>
            <StatusBar />
          </SolanaProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
