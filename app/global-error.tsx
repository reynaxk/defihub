"use client";

import { useEffect } from "react";
import "./globals.css";

// Renders in place of the root layout, so it can't depend on anything the
// layout itself might have failed on (Navbar reads the session, which
// reads the DB) - kept deliberately dependency-free.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <h1 className="text-xl font-semibold tracking-tight">DeFiHub hit an error</h1>
          <p className="text-muted-foreground">
            The whole page failed to load. Try again in a moment.
          </p>
          <button
            onClick={reset}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/80"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
