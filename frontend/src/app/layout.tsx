import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/context/AuthContext';
import { SocketProvider } from '@/lib/useSocket';
import { ChatProvider } from '@/context/ChatContext';
import { CallProvider } from '@/context/CallContext';
import CallOverlay from '@/components/Call/CallOverlay';

export const metadata: Metadata = {
  title: 'Gathor Chat',
  icons: {
    icon: '/logo.png',
  },
  openGraph: {
    title: 'Gathor Chat',
    description: 'Connect. Collaborate. Grow.',
    url: 'https://chat.gathor.online',
    siteName: 'Gathor Chat',
    images: [
      {
        url: '/og-image.jpg',
        width: 1200,
        height: 630,
        alt: 'Gathor Chat',
      },
    ],
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface text-white antialiased">
        <AuthProvider>
          <SocketProvider>
            <ChatProvider>
              <CallProvider>
                {children}
                <CallOverlay />
              </CallProvider>
            </ChatProvider>
          </SocketProvider>
        </AuthProvider>
      </body>
    </html>
  );
}

