import type { ReactNode } from 'react';

export interface PageFrameProps {
  children: ReactNode;
  className?: string;
}

export function PageFrame({ children, className }: PageFrameProps) {
  return (
    <main
      data-testid="page-frame"
      className={[
        'mx-auto flex w-full max-w-screen-2xl flex-1 min-h-0 flex-col overflow-y-auto bg-bg',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </main>
  );
}
