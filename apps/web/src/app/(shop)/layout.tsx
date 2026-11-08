import type { ReactNode } from 'react';
import { Chatbot } from '@/components/shop/chatbot';
import { BottomNav, NotificationStream, ShopFooter, ShopHeader } from '@/components/shop/header';

export default function ShopLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <ShopHeader />
      <main className="mx-auto w-full min-w-0 max-w-7xl flex-1 px-4 pt-4 pb-[calc(var(--bottom-nav-h)+var(--safe-bottom)+24px)] md:pb-10 md:pt-6">
        {children}
      </main>
      <ShopFooter />
      <BottomNav />
      <Chatbot />
      <NotificationStream />
    </div>
  );
}
